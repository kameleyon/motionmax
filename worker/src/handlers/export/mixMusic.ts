/**
 * Mix Lyria-generated background music and/or SFX bed under the
 * narrated video via ffmpeg. Both tracks are ducked against the
 * voiceover using sidechain compression so they breathe around the
 * narration like a broadcast mix.
 *
 * Pipeline (when both music + sfx present):
 *   [0:a] voiceover (already in video)
 *   [1:a] music track — looped
 *   [2:a] sfx track   — looped
 *
 *   [1:a] volume=0.55          → [music_raw]
 *   [2:a] volume=0.25          → [sfx_raw]
 *   [music_raw][0:a] sidechain → [music_ducked]
 *   [sfx_raw][0:a]   sidechain → [sfx_ducked]
 *   [0:a][music_ducked][sfx_ducked] amix(duration=first) → [aout]
 *
 *   -map 0:v -c:v copy   (instant, no re-encode)
 *   -map [aout] -c:a aac 192k
 *
 * The mix function is called once per export with whichever beds are
 * present. Either url can be null → that branch is skipped in the
 * filter_complex graph.
 */

import fs from "fs";
import path from "path";
import { runFfmpeg } from "./ffmpegCmd.js";

/** Download a Lyria MP3 URL to a local temp file. Returns the path.
 *  Separate from the mix step so we can probe duration / clean up
 *  independently. */
async function downloadLyriaTrack(url: string, tempDir: string, label: string): Promise<string> {
  const outPath = path.join(tempDir, `lyria-${label}-${Date.now()}.mp3`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} download failed: ${response.status} ${response.statusText}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length < 1024) {
    throw new Error(`${label} download returned too few bytes (${buf.length})`);
  }
  await fs.promises.writeFile(outPath, buf);
  return outPath;
}

/**
 * Mix music and/or SFX beds under an existing video's narration audio.
 *
 * @param videoInputPath  Path to the concatenated video with narration baked in.
 * @param musicUrl        Optional Lyria music track URL. Null to skip.
 * @param sfxUrl          Optional Lyria SFX/ambient bed URL. Null to skip.
 * @param outputPath      Path to write the mixed video.
 * @param tempDir         Temp directory for track downloads (cleaned on return).
 */
export async function mixBackgroundMusic(
  videoInputPath: string,
  musicUrl: string | null,
  sfxUrl: string | null,
  outputPath: string,
  tempDir: string,
): Promise<void> {
  const hasMusic = !!musicUrl;
  const hasSfx = !!sfxUrl;
  if (!hasMusic && !hasSfx) {
    throw new Error("mixBackgroundMusic called with neither music nor sfx");
  }

  console.log(`[MixAudio] Mixing ${[hasMusic && "music", hasSfx && "sfx"].filter(Boolean).join(" + ")} under narration`);

  const tracks: { path: string; label: string }[] = [];
  try {
    if (hasMusic) {
      tracks.push({ path: await downloadLyriaTrack(musicUrl!, tempDir, "music"), label: "music" });
    }
    if (hasSfx) {
      tracks.push({ path: await downloadLyriaTrack(sfxUrl!, tempDir, "sfx"), label: "sfx" });
    }

    // ffmpeg input indices: 0 = video-with-voice, 1..N = lyria tracks
    // Volume levels: music=0.55 (bed), sfx=0.25 (atmospheric wash)
    // Each lyria track goes through sidechaincompress against the
    // voiceover so it ducks when the narrator speaks. Final amix
    // combines voice + all ducked beds.
    const filterParts: string[] = [];
    const duckedLabels: string[] = [];
    tracks.forEach((t, idx) => {
      const ffmpegIdx = idx + 1;
      const volume = t.label === "music" ? 0.55 : 0.25;
      filterParts.push(`[${ffmpegIdx}:a]volume=${volume}[${t.label}_raw]`);
      filterParts.push(`[${t.label}_raw][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=500[${t.label}_ducked]`);
      duckedLabels.push(`[${t.label}_ducked]`);
    });
    const mixInputs = ["[0:a]", ...duckedLabels].join("");
    const mixWeights = ["1", ...tracks.map(() => "1")].join(" ");
    filterParts.push(
      `${mixInputs}amix=inputs=${tracks.length + 1}:duration=first:dropout_transition=0:weights=${mixWeights}[aout]`,
    );
    const filterComplex = filterParts.join(";");

    const args: string[] = ["-i", videoInputPath];
    for (const t of tracks) {
      args.push("-stream_loop", "-1", "-i", t.path);
    }
    args.push(
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
    );

    await runFfmpeg(args);
    console.log(`[MixAudio] Mix complete → ${outputPath}`);
  } finally {
    for (const t of tracks) {
      try { fs.unlinkSync(t.path); } catch { /* ignore */ }
    }
  }
}
