/**
 * Replace the audio track of a concatenated scene-mp4 with the
 * generation's continuous master TTS audio file.
 *
 * Why: handleMasterAudio slices the master mp3 into per-scene segments
 * so each scene clip in the editor has its own audioUrl (used for
 * preview, captions, and per-scene regeneration). The slicing is a
 * trim+re-encode at MP3 frame boundaries — every seam introduces a
 * tiny click / 10–40 ms of silence as the decoder resyncs. Across 15
 * scenes those seams are clearly audible and break the "one
 * narrator" illusion.
 *
 * Fix: at export time, after the per-scene clips are concatenated, we
 * strip the spliced audio track and replace it with the original
 * unedited master mp3 in a single ffmpeg pass. The video stream is
 * stream-copied (no re-encode → fast); only the audio is replaced.
 *
 * Drift handling: ffmpeg slicing introduces small per-scene rounding
 * (the planned sliceMs and the actual mp3 duration drift by a few
 * tens of ms). Sum of those drifts can leave the concat video shorter
 * or longer than the master audio. We probe both, then:
 *   - within ±50 ms → straight remux with -shortest
 *   - audio longer  → pad final video frame to match (tpad clone)
 *   - video longer  → trim video to audio length
 *
 * The result: one continuous narration track with no audible cuts.
 */

import path from "path";
import { runFfmpeg, probeDuration } from "./ffmpegCmd.js";
import { streamToFile } from "./storageHelpers.js";

export interface ReplaceMasterAudioOptions {
  /** Concatenated per-scene mp4 (output of concatScenes). */
  videoPath: string;
  /** Public Supabase URL of the master mp3 from
   *  generations.master_audio_url. */
  masterAudioUrl: string;
  /** Where to write the muxed result. */
  outputPath: string;
  /** Scratch dir to land the downloaded master mp3. */
  tempDir: string;
}

/** Sub-second drift below this threshold is inaudible — we skip the
 *  pad/trim branch and just remux with -shortest. */
const DRIFT_TOLERANCE_SEC = 0.05;

export async function replaceMasterAudio(opts: ReplaceMasterAudioOptions): Promise<void> {
  const { videoPath, masterAudioUrl, outputPath, tempDir } = opts;

  const masterPath = path.join(tempDir, "master_replace.mp3");
  await streamToFile(masterAudioUrl, masterPath, "audio");

  const [videoDur, audioDur] = await Promise.all([
    probeDuration(videoPath),
    probeDuration(masterPath),
  ]);
  const drift = audioDur - videoDur;

  console.log(
    `[ReplaceMasterAudio] video=${videoDur.toFixed(2)}s, ` +
    `master=${audioDur.toFixed(2)}s, drift=${drift.toFixed(2)}s`,
  );

  if (Math.abs(drift) <= DRIFT_TOLERANCE_SEC) {
    // Within tolerance — straight remux. Video is bit-identical;
    // audio swap costs only the AAC re-encode.
    await runFfmpeg([
      "-i", videoPath,
      "-i", masterPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",
      "-shortest",
      "-movflags", "+faststart",
      outputPath,
    ]);
    return;
  }

  if (drift > 0) {
    // Audio longer than video — clone the last frame of video to fill
    // the gap so the narrator's tail isn't played over a black screen.
    // tpad's stop_duration is added on top of input duration; we
    // round up slightly so we don't undershoot.
    const padDur = (drift + 0.05).toFixed(3);
    await runFfmpeg([
      "-i", videoPath,
      "-i", masterPath,
      "-filter_complex", `[0:v]tpad=stop_mode=clone:stop_duration=${padDur}[vpad]`,
      "-map", "[vpad]",
      "-map", "1:a:0",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",
      "-t", audioDur.toFixed(3),
      "-movflags", "+faststart",
      outputPath,
    ]);
    return;
  }

  // Video longer than audio — trim video tail. Same stream-copy speed
  // as the in-tolerance branch.
  await runFfmpeg([
    "-i", videoPath,
    "-i", masterPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    "-t", audioDur.toFixed(3),
    "-movflags", "+faststart",
    outputPath,
  ]);
}
