/**
 * Shared per-scene audio slicing for master-audio projects.
 *
 * A single continuous master TTS track has to be mapped back to N scenes
 * so each scene's VISUAL clip can be sized to that scene's spoken
 * duration. Getting these per-scene durations right is what keeps the
 * exported video frame in sync with the narration.
 *
 * Used in two places that MUST agree:
 *   - handleMasterAudio (generation time): slices the master + sizes
 *     each scene's stored audioUrl / duration.
 *   - exportVideo (export time): re-derives the same durations so a
 *     re-export self-corrects sync for any project — old rows included —
 *     without regenerating the audio.
 */

import type { SilenceInterval } from "../handlers/export/ffmpegCmd.js";

export interface SceneSlice {
  startMs: number;
  sliceMs: number;
  words: number;
}

/**
 * Compute per-scene audio slices from the master track.
 *
 * Two-stage approach:
 *   1. Word-count proportion gives an initial ESTIMATE of where each
 *      scene's narration ends in the master.
 *   2. Each internal boundary is then snapped to the nearest detected
 *      SILENCE (natural pause) within ±SNAP_WINDOW_MS. Slices land in
 *      pauses (no mid-word cuts) and per-scene durations track the real
 *      narration pace instead of a uniform words-per-second guess.
 *
 * The LAST boundary is always pinned to the true master duration so the
 * final scene covers all remaining audio — no "last frame freezes while
 * the narrator keeps talking" tail.
 *
 * Pass `silences = []` for pure word-count behavior (still with the last
 * boundary pinned) — the graceful fallback when silence detection is
 * unavailable.
 */
export function buildSceneSlices(
  scenes: Array<{ voiceover?: unknown }>,
  durationMs: number,
  silences: SilenceInterval[],
): SceneSlice[] {
  const n = scenes.length;
  const wordsPerScene = scenes.map((s) =>
    typeof s.voiceover === "string"
      ? s.voiceover.trim().split(/\s+/).filter(Boolean).length
      : 0,
  );
  const totalWords = wordsPerScene.reduce((a, b) => a + b, 0) || 1;

  if (n <= 1) {
    return [{ startMs: 0, sliceMs: Math.max(500, Math.round(durationMs)), words: wordsPerScene[0] ?? 0 }];
  }

  // Stage 1 — estimated cumulative END (ms) of each scene by word share.
  const estBoundary: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += (wordsPerScene[i] / totalWords) * durationMs;
    estBoundary.push(acc);
  }

  // Silence midpoints (ms) are the candidate cut points.
  const cutPoints = silences
    .map((s) => ((s.start + s.end) / 2) * 1000)
    .filter((ms) => ms > 0 && ms < durationMs)
    .sort((a, b) => a - b);

  const SNAP_WINDOW_MS = 2000; // snap a boundary to a pause within ±2s
  const MIN_SLICE_MS = 300;    // keep every slice non-trivial + monotonic

  // Stage 2 — snap each INTERNAL boundary (0..n-2) to nearest pause,
  // keeping boundaries strictly increasing. Last boundary = master end.
  const boundary: number[] = new Array(n);
  let prev = 0;
  for (let i = 0; i < n - 1; i++) {
    const target = estBoundary[i];
    let best = target;
    let bestDist = SNAP_WINDOW_MS + 1;
    for (const cp of cutPoints) {
      if (cp <= prev + MIN_SLICE_MS) continue;       // would make scene i too short
      if (cp >= durationMs - MIN_SLICE_MS) break;    // leave room for last scene
      const d = Math.abs(cp - target);
      if (d < bestDist) { bestDist = d; best = cp; }
    }
    const snapped = bestDist <= SNAP_WINDOW_MS ? best : target;
    boundary[i] = Math.max(prev + MIN_SLICE_MS, Math.min(snapped, durationMs - MIN_SLICE_MS));
    prev = boundary[i];
  }
  boundary[n - 1] = durationMs; // last scene → all remaining audio

  // Boundaries → slices.
  const slices: SceneSlice[] = [];
  let startMs = 0;
  for (let i = 0; i < n; i++) {
    const endMs = boundary[i];
    slices.push({
      startMs: Math.round(startMs),
      sliceMs: Math.max(500, Math.round(endMs - startMs)),
      words: wordsPerScene[i],
    });
    startMs = endMs;
  }
  return slices;
}
