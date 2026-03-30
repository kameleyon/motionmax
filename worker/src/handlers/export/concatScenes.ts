/**
 * Concatenate MP4 clips using the ffmpeg concat **demuxer**.
 *
 * Two modes:
 *   • streamCopy = true  → fast, safe for clips created with identical params
 *   • streamCopy = false → full re-encode, needed for final scene join
 *     (normalises codecs, sample rates, frame boundaries)
 */
import fs from "fs";
import { runFfmpeg, X264_MEM_FLAGS } from "./ffmpegCmd.js";

/**
 * Concat MP4 files via demuxer.
 * @param streamCopy  true = fast stream-copy (same-codec sub-clips); false = re-encode (default)
 */
export async function concatFiles(
  files: string[],
  outputPath: string,
  streamCopy = false
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

  const mode = streamCopy ? "stream-copy" : "re-encode";
  console.log(`[ConcatScenes] Joining ${files.length} clips (${mode})`);

  try {
    if (streamCopy) {
      await runFfmpeg([
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        "-movflags", "+faststart",
        outputPath,
      ]);
    } else {
      await runFfmpeg([
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
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
        outputPath,
      ]);
    }
  } finally {
    try { fs.unlinkSync(listPath); } catch { /* ignore */ }
  }
}
