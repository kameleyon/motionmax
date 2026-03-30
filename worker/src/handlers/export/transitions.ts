/**
 * Crossfade transition engine for video export.
 *
 * Replaces hard-cut concat with smooth dissolve transitions between scenes
 * using FFmpeg's xfade (video) and acrossfade (audio) filters.
 *
 * Architecture — PAIRWISE CROSSFADE:
 *   Instead of one massive filter_complex (which crashes FFmpeg on 6+ clips),
 *   we merge clips 2 at a time iteratively:
 *
 *     scene0 + scene1 → merged01 (with xfade)
 *     merged01 + scene2 → merged012 (with xfade)
 *     merged012 + scene3 → merged0123 (with xfade)
 *     ...
 *
 *   Each FFmpeg call has only 2 inputs and 1 xfade + 1 acrossfade filter.
 *   Safe on any instance size. Quality loss from iterative re-encoding
 *   is negligible with ultrafast preset.
 *
 * Falls back to concat demuxer if any crossfade step fails.
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

// ── Public API ───────────────────────────────────────────────────────

/**
 * Concatenate clips with crossfade transitions using pairwise merging.
 *
 * Merges clips iteratively (2 at a time) to keep FFmpeg memory low.
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

  // Probe all clip durations upfront
  console.log(`[Transitions] Probing ${clipPaths.length} clips for crossfade...`);
  const durations = await Promise.all(clipPaths.map(probeDuration));

  // Validate: all clips must be longer than crossfade duration
  const tooShort = durations.filter((d) => d < opts.duration + 0.1);
  if (tooShort.length > 0) {
    console.warn(
      `[Transitions] ${tooShort.length} clip(s) shorter than crossfade (${opts.duration}s) — falling back to concat`
    );
    await concatFiles(clipPaths, outputPath, false);
    return false;
  }

  const totalInput = durations.reduce((a, b) => a + b, 0);
  console.log(
    `[Transitions] Pairwise ${opts.transition} crossfade (${opts.duration}s) — ` +
    `${clipPaths.length} clips, ${totalInput.toFixed(1)}s total input`
  );

  try {
    await pairwiseCrossfade(clipPaths, durations, outputPath, opts);

    const totalReduction = opts.duration * (clipPaths.length - 1);
    console.log(
      `[Transitions] Crossfade complete — ${clipPaths.length - 1} transitions, ` +
      `reduced by ${totalReduction.toFixed(1)}s`
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Transitions] Pairwise crossfade failed — falling back to concat: ${msg}`);
    await concatFiles(clipPaths, outputPath, false);
    return false;
  }
}

// ── Pairwise Crossfade ───────────────────────────────────────────────

/**
 * Merge clips 2 at a time with xfade + acrossfade.
 * Each step produces an intermediate file that feeds into the next.
 */
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

    // xfade offset = duration of current merged clip minus crossfade
    const offset = Math.max(0, currentDuration - opts.duration);

    console.log(
      `[Transitions] Pair ${i}/${totalPairs}: ` +
      `${currentDuration.toFixed(1)}s + ${nextDuration.toFixed(1)}s → offset=${offset.toFixed(3)}s`
    );

    const filterComplex =
      `[0:v][1:v]xfade=transition=${opts.transition}:duration=${opts.duration}:offset=${offset.toFixed(3)}[vout];` +
      `[0:a][1:a]acrossfade=d=${opts.duration}:c1=tri:c2=tri[aout]`;

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

    // Clean up previous temp file (not the original clips)
    if (i >= 2 && tempFiles.length >= 2) {
      const prevTemp = tempFiles[tempFiles.length - 2];
      try { fs.unlinkSync(prevTemp); } catch { /* ignore */ }
    }

    // New merged clip duration = current + next - crossfade
    currentDuration = currentDuration + nextDuration - opts.duration;
    currentPath = outPath;

    // Report progress after each pair
    if (opts.onPairComplete) {
      try {
        await opts.onPairComplete(i, totalPairs);
      } catch { /* non-critical */ }
    }
  }

  // Clean any remaining temp files
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
