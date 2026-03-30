/**
 * Crossfade transition engine for video export.
 *
 * Replaces hard-cut concat with smooth dissolve transitions between scenes
 * using FFmpeg's xfade (video) and acrossfade (audio) filters.
 *
 * Architecture:
 *   1. Probe all clip durations
 *   2. Build xfade + acrossfade filter_complex chain
 *   3. Execute single FFmpeg call with the complete chain
 *   4. Falls back to concat demuxer if filter_complex fails
 *
 * Requirements for crossfade:
 *   - All clips must have identical resolution, FPS, pixel format
 *   - All clips must have an audio track (even if silent)
 *   - Clips must be ≥ crossfade duration
 *
 * Memory considerations:
 *   xfade processes clips sequentially — only ~0.5s of overlap frames
 *   are held in memory at any time. Safe on 2GB Render instances.
 */
import { runFfmpeg, probeDuration } from "./ffmpegCmd.js";
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
  /** FFmpeg timeout in ms (default 30 min) */
  timeoutMs: number;
}

const DEFAULT_OPTIONS: CrossfadeOptions = {
  duration: 0.5,
  transition: "fade",
  timeoutMs: 30 * 60 * 1000,
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Concatenate clips with crossfade transitions between each pair.
 *
 * Uses FFmpeg filter_complex with chained xfade (video) + acrossfade (audio).
 * Falls back to simple concat demuxer if filter_complex fails.
 *
 * @param clipPaths    Ordered array of MP4 clip paths
 * @param outputPath   Path for the concatenated output
 * @param options      Crossfade configuration
 * @returns            True if crossfade was applied, false if fell back to concat
 */
export async function concatWithCrossfade(
  clipPaths: string[],
  outputPath: string,
  options: Partial<CrossfadeOptions> = {}
): Promise<boolean> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Fewer than 2 clips: no transitions possible
  if (clipPaths.length < 2) {
    await concatFiles(clipPaths, outputPath, false);
    return false;
  }

  // Probe all clip durations
  console.log(`[Transitions] Probing ${clipPaths.length} clips for crossfade...`);
  const durations = await Promise.all(clipPaths.map(probeDuration));

  // Validate: all clips must be longer than the crossfade duration
  const tooShort = durations.filter((d) => d < opts.duration + 0.1);
  if (tooShort.length > 0) {
    console.warn(
      `[Transitions] ${tooShort.length} clip(s) shorter than crossfade (${opts.duration}s) — falling back to concat`
    );
    await concatFiles(clipPaths, outputPath, false);
    return false;
  }

  // Build the filter chain
  const { filterComplex, lastVideoLabel, lastAudioLabel } = buildFilterChain(
    clipPaths.length,
    durations,
    opts.duration,
    opts.transition
  );

  // Build FFmpeg args
  const args: string[] = [];

  // Input files
  for (const clip of clipPaths) {
    args.push("-i", clip);
  }

  // Filter complex
  args.push("-filter_complex", filterComplex);

  // Map outputs
  args.push("-map", `[${lastVideoLabel}]`);
  args.push("-map", `[${lastAudioLabel}]`);

  // Output encoding
  args.push(
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-movflags", "+faststart",
    "-threads", "2",
    "-refs", "1",
    "-rc-lookahead", "0",
    "-g", "24",
    "-bf", "0",
    outputPath
  );

  console.log(
    `[Transitions] Applying ${opts.transition} crossfade (${opts.duration}s) to ${clipPaths.length} clips ` +
    `— total input duration: ${durations.reduce((a, b) => a + b, 0).toFixed(1)}s`
  );

  try {
    await runFfmpeg(args, opts.timeoutMs);
    const totalCrossfadeReduction = opts.duration * (clipPaths.length - 1);
    console.log(
      `[Transitions] Crossfade complete — reduced total by ${totalCrossfadeReduction.toFixed(1)}s from transitions`
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Transitions] filter_complex failed — falling back to concat demuxer: ${msg}`);

    // Fallback: concat demuxer (re-encode for compatibility)
    await concatFiles(clipPaths, outputPath, false);
    return false;
  }
}

// ── Filter Chain Builder ─────────────────────────────────────────────

/**
 * Build the filter_complex string for chained xfade + acrossfade.
 *
 * For N clips, generates N-1 xfade filters (video) and N-1 acrossfade filters (audio).
 *
 * Video chain example (3 clips):
 *   [0:v][1:v]xfade=transition=fade:duration=0.5:offset=D0-0.5[v01];
 *   [v01][2:v]xfade=transition=fade:duration=0.5:offset=D0+D1-1.0[v012]
 *
 * Audio chain example (3 clips):
 *   [0:a][1:a]acrossfade=d=0.5:c1=tri:c2=tri[a01];
 *   [a01][2:a]acrossfade=d=0.5:c1=tri:c2=tri[a012]
 */
function buildFilterChain(
  clipCount: number,
  durations: number[],
  crossfadeDuration: number,
  transition: TransitionType
): {
  filterComplex: string;
  lastVideoLabel: string;
  lastAudioLabel: string;
} {
  const filters: string[] = [];
  let prevVideoLabel = "0:v";
  let prevAudioLabel = "0:a";

  // Running offset for xfade: cumulative duration minus accumulated crossfade shrinkage
  let cumulativeDuration = durations[0];

  for (let i = 1; i < clipCount; i++) {
    const videoOutLabel = `v${i}`;
    const audioOutLabel = `a${i}`;

    // Video: xfade
    // Offset = cumulative duration of all clips so far (minus accumulated crossfades) minus this crossfade
    const offset = Math.max(0, cumulativeDuration - crossfadeDuration);

    filters.push(
      `[${prevVideoLabel}][${i}:v]xfade=transition=${transition}:duration=${crossfadeDuration}:offset=${offset.toFixed(3)}[${videoOutLabel}]`
    );

    // Audio: acrossfade
    // acrossfade has no offset — it always fades at the junction point
    filters.push(
      `[${prevAudioLabel}][${i}:a]acrossfade=d=${crossfadeDuration}:c1=tri:c2=tri[${audioOutLabel}]`
    );

    // Update running state
    cumulativeDuration = offset + durations[i];
    prevVideoLabel = videoOutLabel;
    prevAudioLabel = audioOutLabel;
  }

  return {
    filterComplex: filters.join(";"),
    lastVideoLabel: prevVideoLabel,
    lastAudioLabel: prevAudioLabel,
  };
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
