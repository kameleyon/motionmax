/**
 * Compress a final MP4 when it exceeds the upload-safe threshold.
 * Re-encodes with CRF 28 + maxrate to bring the file under the
 * Supabase Storage bucket limit while preserving acceptable quality.
 */
import fs from "fs";
import { runFfmpeg, X264_MEM_FLAGS } from "./ffmpegCmd.js";

/** Files above this size trigger a compression re-encode before upload. */
const COMPRESS_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * If the file exceeds COMPRESS_THRESHOLD_BYTES, re-encode it with
 * CRF 28 + maxrate 4M to shrink below the Supabase bucket limit.
 * Returns the (possibly new) path to the file ready for upload.
 */
export async function compressIfNeeded(
  filePath: string,
  tempDir: string
): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);

  if (stat.size <= COMPRESS_THRESHOLD_BYTES) {
    console.log(`[CompressVideo] ${sizeMB} MB — within threshold, skipping compression`);
    return filePath;
  }

  console.log(`[CompressVideo] ${sizeMB} MB exceeds ${COMPRESS_THRESHOLD_BYTES / (1024 * 1024)} MB — compressing`);

  const compressedPath = filePath.replace(".mp4", "_compressed.mp4");

  await runFfmpeg([
    "-i", filePath,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "28",
    "-maxrate", "4M",
    "-bufsize", "8M",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    compressedPath,
  ]);

  const compStat = await fs.promises.stat(compressedPath);
  const compMB = (compStat.size / (1024 * 1024)).toFixed(1);
  console.log(`[CompressVideo] Compressed: ${sizeMB} MB → ${compMB} MB`);

  // Replace original with compressed version
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }

  return compressedPath;
}
