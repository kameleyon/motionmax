/**
 * Concatenate MP4 clips using the ffmpeg concat **demuxer**.
 *
 * This approach writes a `concat.txt` list file and runs:
 *   ffmpeg -f concat -safe 0 -i concat.txt -c copy output.mp4
 *
 * It completely avoids -filter_complex / xfade which are the root cause
 * of the "Error initializing complex filters" crash. The trade-off is
 * no cross-fade transitions — scenes cut cleanly — but it is rock-solid.
 *
 * If inputs have different codecs we re-encode; if they match we stream-copy.
 */
import fs from "fs";
import path from "path";
import { runFfmpeg, X264_MEM_FLAGS } from "./ffmpegCmd.js";

/** Concat MP4 files using the demuxer. Writes concat list → runs ffmpeg. */
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
  const listContent = files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
  await fs.promises.writeFile(listPath, listContent, "utf-8");

  console.log(`[ConcatScenes] Joining ${files.length} clips via concat demuxer`);

  try {
    // Try stream-copy first (fast, no re-encode)
    await runFfmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath,
    ]);
  } catch {
    // If stream-copy fails (codec mismatch), fall back to re-encode
    console.warn("[ConcatScenes] Stream-copy concat failed — re-encoding");
    await runFfmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      ...X264_MEM_FLAGS,
      outputPath,
    ]);
  } finally {
    try { fs.unlinkSync(listPath); } catch { /* ignore */ }
  }
}
