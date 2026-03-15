/**
 * Concatenate MP4 clips using the ffmpeg concat **demuxer**.
 *
 * Always re-encodes both video and audio to normalise all streams.
 * Stream-copy concat is risky because mismatched codecs, sample rates,
 * or frame boundaries can truncate audio at scene joins.
 */
import fs from "fs";
import { runFfmpeg, X264_MEM_FLAGS } from "./ffmpegCmd.js";

/** Concat MP4 files via demuxer WITH full re-encode for safety. */
export async function concatFiles(
  files: string[],
  outputPath: string
): Promise<void> {
  if (files.length === 0) {
    throw new Error("concatFiles: no files to concatenate");
  }

  if (files.length === 1) {
    await fs.promises.copyFile(files[0], outputPath);
    return;
  }

  const listPath = outputPath + ".concat.txt";
  const listContent = files
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.promises.writeFile(listPath, listContent, "utf-8");

  console.log(`[ConcatScenes] Joining ${files.length} clips — full re-encode for audio safety`);

  try {
    await runFfmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      ...X264_MEM_FLAGS,
      outputPath,
    ]);
  } finally {
    try { fs.unlinkSync(listPath); } catch { /* ignore */ }
  }
}
