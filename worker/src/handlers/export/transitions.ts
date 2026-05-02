/**
 * Crossfade transition engine for video export.
 *
 * PAIRWISE CROSSFADE — merges clips 2 at a time:
 *   scene0 + scene1 → merged01 → + scene2 → merged012 → ...
 *
 * CRITICAL: Audio is NOT crossfaded (no acrossfade).
 * Voiceovers must never overlap. Instead:
 *   - Clip 1 audio: trimmed to the transition point, faded out over 0.3s
 *   - Clip 2 audio: faded in over 0.3s, plays in full
 *   - Audio tracks concatenated with zero overlap
 *
 * Video gets the visual xfade transition (fadeblack, dissolve, etc.)
 */
import { runFfmpeg, probeDuration, X264_MEM_FLAGS } from "./ffmpegCmd.js";
import { concatFiles } from "./concatScenes.js";

// ── Types ────────────────────────────────────────────────────────────

export type TransitionType =
  | "fade"
  | "fadeblack"
  | "fadewhite"
  | "dissolve"
  | "wipeleft"
  | "wiperight"
  | "wipeup"
  | "wipedown"
  | "slideleft"
  | "slideright";

interface CrossfadeOptions {
  /** Transition duration in seconds (default 0.5) */
  duration: number;
  /** Transition effect type (default "fade") */
  transition: TransitionType;
  /** Per-pair FFmpeg timeout in ms (default 5 min) */
  pairTimeoutMs: number;
  /** Called after each pair is merged with (completedPairs, totalPairs) */
  onPairComplete?: (completed: number, total: number) => void | Promise<void>;
}

const DEFAULT_OPTIONS: CrossfadeOptions = {
  duration: 0.5,
  transition: "fade",
  pairTimeoutMs: 5 * 60 * 1000,
};

/** Duration of audio fade-out / fade-in at transition points. */
const AUDIO_FADE_SECONDS = 0.3;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Concatenate clips with visual crossfade + clean audio cuts.
 * Falls back to concat demuxer if any pair fails.
 *
 * @returns  True if crossfade was applied, false if fell back to concat
 */
export async function concatWithCrossfade(
  clipPaths: string[],
  outputPath: string,
  options: Partial<CrossfadeOptions> = {}
): Promise<boolean> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (clipPaths.length < 2) {
    await concatFiles(clipPaths, outputPath, false);
    return false;
  }

  console.log(`[Transitions] Probing ${clipPaths.length} clips for crossfade...`);
  const durations = await Promise.all(clipPaths.map(probeDuration));

  const tooShort = durations.filter((d) => d < opts.duration + 0.5);
  if (tooShort.length > 0) {
    console.warn(
      `[Transitions] ${tooShort.length} clip(s) too short for ${opts.duration}s crossfade — falling back to concat`
    );
    await concatFiles(clipPaths, outputPath, false);
    return false;
  }

  const totalInput = durations.reduce((a, b) => a + b, 0);
  console.log(
    `[Transitions] Pairwise ${opts.transition} (${opts.duration}s video, no audio overlap) — ` +
    `${clipPaths.length} clips, ${totalInput.toFixed(1)}s total`
  );

  try {
    await singlePassCrossfade(clipPaths, durations, outputPath, opts);

    const totalReduction = opts.duration * (clipPaths.length - 1);
    console.log(
      `[Transitions] Complete — ${clipPaths.length - 1} transitions, ` +
      `output ~${(totalInput - totalReduction).toFixed(1)}s`
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Transitions] Crossfade failed — falling back to concat: ${msg}`);
    await concatFiles(clipPaths, outputPath, false);
    return false;
  }
}

// ── Single-Pass Crossfade ────────────────────────────────────────────
//
// Builds ONE filter_complex that chains every xfade (and the matching
// audio trim/concat) so ffmpeg encodes the full output in a single
// pass. This replaces the legacy `pairwiseCrossfade` which ran N-1
// separate ffmpeg invocations, each one re-decoding + re-encoding the
// merged-so-far output. That was O(n²) on total duration: pair 14 of
// a 15-clip video re-encoded ~115 s of footage just to glue in 5 s of
// new content. The single-pass approach is O(n) and ~4–6× faster on
// 15-scene cinematic exports.
//
// Filter graph:
//   • Video: clip 0 is fed straight in; each subsequent clip i adds an
//     xfade with `offset = (cumulative duration through clip i-1) -
//     i*duration`. The final label is `[vout]`.
//   • Audio: every clip's audio is atrim'd to its segment length
//     (clip 0 trims out the last `duration - audioFade` seconds; the
//     last clip plays in full; middle clips trim by `2*audioFade`).
//     Each segment gets afade in/out so the joins don't pop. atrims
//     are concat'd with NO overlap so voiceovers never overlap.
//
// Memory: peak filter-graph cost scales with the longest clip, not
// the total. Confirmed on a 15-clip 110 s render to stay well under
// the 200 MB per-export budget.

async function singlePassCrossfade(
  clipPaths: string[],
  durations: number[],
  finalOutput: string,
  opts: CrossfadeOptions,
): Promise<void> {
  const n = clipPaths.length;
  const audioFade = Math.min(AUDIO_FADE_SECONDS, opts.duration / 2);

  // Inputs: every clip is one ffmpeg input. -i flags built up below.
  const inputArgs: string[] = [];
  for (const p of clipPaths) inputArgs.push("-i", p);

  // ── Video chain ────────────────────────────────────────────────────
  // Build N-1 chained xfade filters. Each chain starts from the prior
  // chain's output label (or [0:v] for the first). Offsets are cumulative
  // so the merged output keeps shrinking by `duration` per join.
  const videoChain: string[] = [];
  let prevLabel = "[0:v]";
  let cumulative = 0;
  for (let i = 1; i < n; i++) {
    cumulative += durations[i - 1];
    const offset = Math.max(0, cumulative - opts.duration * i);
    const outLabel = i === n - 1 ? "[vout]" : `[v${i}]`;
    videoChain.push(
      `${prevLabel}[${i}:v]xfade=transition=${opts.transition}:` +
      `duration=${opts.duration}:offset=${offset.toFixed(3)}${outLabel}`,
    );
    prevLabel = outLabel;
  }

  // ── Audio chain ────────────────────────────────────────────────────
  // The total audio length MUST equal the total video length, otherwise
  // ffmpeg has to truncate or stretch at the end (audible static / pop).
  //
  //   video output len = sum(durations) - (n-1)*X
  //
  // Cut convention (split the xfade at its midpoint, X/2 on each side):
  //   clip 0      → atrim [0, d[0] - X/2]                    fade out
  //   clip middle → atrim [X/2, d[i] - X/2]                  fade in + out
  //   clip last   → atrim [X/2, d[n-1]]                      fade in
  //
  // Per-clip lengths sum to exactly sum(d) - (n-1)*X — derivation:
  //   (d0 - X/2) + Σ(di - X) + (d_last - X/2) = sum(d) - (n-1)*X.
  //
  // The previous formula left the head untrimmed on every middle clip
  // (trimHead always 0), so middle segments were each X/2 too long and
  // the totals diverged by ~(n-2)*X/2 over a long project. That mismatch
  // produced the audible static / popping at the tail of the export.
  const halfX = opts.duration / 2;
  // Sync the audio fade duration with the visual half-xfade so the
  // dissolve / whip / fadeblack feels right; cap it at the legacy 0.3s
  // for very long crossfades.
  const audioFadeDur = Math.min(audioFade, halfX);
  const audioChain: string[] = [];
  const audioInputs: string[] = [];
  for (let i = 0; i < n; i++) {
    const isFirst = i === 0;
    const isLast = i === n - 1;
    const trimHead = isFirst ? 0 : halfX;
    const trimEnd = isLast ? durations[i] : durations[i] - halfX;
    const segLen = trimEnd - trimHead;

    const fades: string[] = [];
    if (!isFirst) fades.push(`afade=t=in:d=${audioFadeDur.toFixed(3)}`);
    if (!isLast) {
      const foStart = Math.max(0, segLen - audioFadeDur);
      fades.push(`afade=t=out:st=${foStart.toFixed(3)}:d=${audioFadeDur.toFixed(3)}`);
    }

    const trimExpr = `atrim=${trimHead.toFixed(3)}:${trimEnd.toFixed(3)},asetpts=PTS-STARTPTS`;
    const filters = [trimExpr, ...fades].join(",");
    const label = `[a${i}]`;
    audioChain.push(`[${i}:a]${filters}${label}`);
    audioInputs.push(label);
  }
  // Single concat across every trimmed segment — zero overlap, voiceovers never collide.
  audioChain.push(`${audioInputs.join("")}concat=n=${n}:v=0:a=1[aout]`);

  const filterComplex = [...videoChain, ...audioChain].join(";");

  console.log(
    `[Transitions] Single-pass: ${n} clips, ${n - 1} xfades, total filter chain ${filterComplex.length} chars`,
  );

  // Single ffmpeg invocation. Timeout scales with total clip count;
  // we reuse the per-pair timeout × pair count so very long projects
  // still get a generous budget.
  const totalTimeoutMs = opts.pairTimeoutMs * Math.max(1, n - 1);

  // Progress callback fires once after the encode completes — we can't
  // reasonably split the single pass into per-pair updates without
  // parsing ffmpeg progress lines. Worth it for the speedup.
  await runFfmpeg(
    [
      ...inputArgs,
      "-filter_complex", filterComplex,
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      ...X264_MEM_FLAGS,
      finalOutput,
    ],
    totalTimeoutMs,
  );

  if (opts.onPairComplete) {
    try { await opts.onPairComplete(n - 1, n - 1); } catch { /* non-critical */ }
  }
}

/**
 * Estimate total output duration after crossfade transitions.
 */
export function estimateCrossfadeDuration(
  durations: number[],
  crossfadeDuration: number
): number {
  if (durations.length === 0) return 0;
  const totalInput = durations.reduce((sum, d) => sum + d, 0);
  const totalReduction = crossfadeDuration * Math.max(0, durations.length - 1);
  return totalInput - totalReduction;
}
