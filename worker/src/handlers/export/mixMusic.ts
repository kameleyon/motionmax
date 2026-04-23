/**
 * Mix a Lyria-generated background music track under the narrated
 * video via ffmpeg.
 *
 * Why sidechaincompress instead of fixed-volume amix:
 *   amix at a fixed mix ratio makes music too loud during silence
 *   between scenes and too quiet during dramatic beats. Sidechain
 *   compression uses the voiceover as a trigger — whenever voice is
 *   above threshold the music compressor kicks in, ducking music by
 *   the compression ratio. When voice is silent the music breathes
 *   back to full level. This is how every broadcast/film mix works.
 *
 * Pipeline:
 *   [0:a] voiceover (already in video)
 *   [1:a] music track (Lyria MP3, looped if shorter than video)
 *
 *   [1:a] → volume=0.55 → [music_raw]
 *   [music_raw][0:a] → sidechaincompress (
 *     threshold=0.05 ratio=8 attack=5 release=500
 *   ) → [music_ducked]
 *   [0:a][music_ducked] → amix(duration=first, weights=1 1) → [aout]
 *
 *   -map 0:v (video stream copy — no re-encode)
 *   -map [aout] (mixed audio)
 *   -c:v copy (instant — we don't touch video)
 *   -c:a aac 192k
 *
 * If the music track is shorter than the video, -stream_loop -1
 * on the music input makes ffmpeg loop it automatically.
 */

import fs from "fs";
import path from "path";
import { runFfmpeg } from "./ffmpegCmd.js";

/** Download the Lyria MP3 URL to a local temp file. Returns the path.
 *  Separate from the mix step so we can probe duration / clean up
 *  independently. */
async function downloadMusicTrack(musicUrl: string, tempDir: string): Promise<string> {
  const outPath = path.join(tempDir, `lyria-bg-${Date.now()}.mp3`);
  const response = await fetch(musicUrl);
  if (!response.ok) {
    throw new Error(`Music download failed: ${response.status} ${response.statusText}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length < 1024) {
    throw new Error(`Music download returned too few bytes (${buf.length})`);
  }
  await fs.promises.writeFile(outPath, buf);
  return outPath;
}

/**
 * Mix background music under an existing video's narration audio.
 *
 * @param videoInputPath  Path to the concatenated (possibly captioned) video.
 *                        Must already have a voiceover audio track.
 * @param musicUrl        Public URL to the Lyria MP3 (set in handleFinalize).
 * @param outputPath      Path to write the mixed video. Caller is responsible
 *                        for replacing the input in their pipeline.
 * @param tempDir         Temp directory to download the music track into.
 *                        Music file is cleaned up before return.
 */
export async function mixBackgroundMusic(
  videoInputPath: string,
  musicUrl: string,
  outputPath: string,
  tempDir: string,
): Promise<void> {
  console.log(`[MixMusic] Mixing Lyria track under narration`);
  const musicPath = await downloadMusicTrack(musicUrl, tempDir);

  // filter_complex:
  //  [1:a]volume=0.55[music_raw]              ← pre-gain the music
  //  [music_raw][0:a]sidechaincompress=...    ← duck music when voice is loud
  //  [0:a][music_ducked]amix=duration=first   ← combine voice + ducked music
  const filterComplex = [
    "[1:a]volume=0.55[music_raw]",
    "[music_raw][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=500[music_ducked]",
    "[0:a][music_ducked]amix=inputs=2:duration=first:dropout_transition=0:weights=1 1[aout]",
  ].join(";");

  try {
    await runFfmpeg([
      "-i", videoInputPath,
      "-stream_loop", "-1", "-i", musicPath,
      "-filter_complex", filterComplex,
      "-map", "0:v",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-ac", "2",
      "-shortest",
      "-movflags", "+faststart",
      outputPath,
    ]);
    console.log(`[MixMusic] Mix complete → ${outputPath}`);
  } finally {
    try { fs.unlinkSync(musicPath); } catch { /* ignore */ }
  }
}
