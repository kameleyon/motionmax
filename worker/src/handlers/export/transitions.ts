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
import fs from "fs";
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
    await pairwiseCrossfade(clipPaths, durations, outputPath, opts);

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

// ── Pairwise Crossfade ───────────────────────────────────────────────

async function pairwiseCrossfade(
  clipPaths: string[],
  durations: number[],
  finalOutput: string,
  opts: CrossfadeOptions
): Promise<void> {
  let currentPath = clipPaths[0];
  let currentDuration = durations[0];
  const tempFiles: string[] = [];
  const totalPairs = clipPaths.length - 1;

  for (let i = 1; i < clipPaths.length; i++) {
    const nextPath = clipPaths[i];
    const nextDuration = durations[i];
    const isLast = i === clipPaths.length - 1;
    const outPath = isLast ? finalOutput : `${finalOutput}.pair_${i}.mp4`;

    if (!isLast) tempFiles.push(outPath);

    const offset = Math.max(0, currentDuration - opts.duration);
    const audioFade = Math.min(AUDIO_FADE_SECONDS, opts.duration / 2);

    console.log(
      `[Transitions] Pair ${i}/${totalPairs}: ` +
      `${currentDuration.toFixed(1)}s + ${nextDuration.toFixed(1)}s → ` +
      `${opts.transition} at ${offset.toFixed(1)}s`
    );

    // VIDEO: xfade visual transition at the offset point
    // AUDIO: clip1 plays in FULL up to the transition point (no early trim),
    //        then fades out gently. Clip2 fades in. Audio tracks are concatenated
    //        with ZERO overlap — voiceovers never cut mid-word.
    //
    // The 1s audio padding from muxVideoAudio ensures the voiceover finishes
    // before the trim point, so only silence gets cut.
    const audioTrimEnd = offset + 0.3; // Extend 0.3s past transition for safety
    const audioFadeOutStart = Math.max(0, offset - audioFade);

    const filterComplex = [
      // Video: smooth visual transition
      `[0:v][1:v]xfade=transition=${opts.transition}:duration=${opts.duration}:offset=${offset.toFixed(3)}[vout]`,
      // Audio clip 1: keep audio slightly past transition point, fade out smoothly
      `[0:a]atrim=0:${audioTrimEnd.toFixed(3)},afade=t=out:st=${audioFadeOutStart.toFixed(3)}:d=${(audioFade + 0.3).toFixed(3)},asetpts=PTS-STARTPTS[a0]`,
      // Audio clip 2: fade in, play in full
      `[1:a]afade=t=in:d=${audioFade.toFixed(3)},asetpts=PTS-STARTPTS[a1]`,
      // Concatenate audio tracks — ZERO overlap
      `[a0][a1]concat=n=2:v=0:a=1[aout]`,
    ].join(";");

    await runFfmpeg([
      "-i", currentPath,
      "-i", nextPath,
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
      outPath,
    ], opts.pairTimeoutMs);

    // Clean up previous temp
    if (i >= 2 && tempFiles.length >= 2) {
      const prevTemp = tempFiles[tempFiles.length - 2];
      try { fs.unlinkSync(prevTemp); } catch { /* ignore */ }
    }

    currentDuration = offset + nextDuration;
    currentPath = outPath;

    if (opts.onPairComplete) {
      try { await opts.onPairComplete(i, totalPairs); } catch { /* non-critical */ }
    }
  }

  for (const tmp of tempFiles) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
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
