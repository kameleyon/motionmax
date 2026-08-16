/**
 * Compress a final MP4 when it exceeds the upload-safe threshold.
 *
 * The bitrate ceiling MUST track the master's resolution. A flat 4 Mbps
 * is reasonable for 1080p but destroys 4K — it would spend the entire
 * upres budget on real detail and then throw that detail away at the
 * last step, producing a file that looks worse than the 1080p export it
 * replaced. `bitrateLadderFor()` picks the ceiling from output height.
 */
import fs from "fs";
import { runFfmpeg, X264_MEM_FLAGS } from "./ffmpegCmd.js";

/** Files above this size trigger a compression re-encode before upload.
 *  Supabase Storage rejects files over ~500 MB even with TUS.
 *  Compress anything over 400 MB to stay safely under the limit. */
const COMPRESS_THRESHOLD_BYTES = 400 * 1024 * 1024; // 400 MB

/** Hard upload ceiling. A master still above this after compression
 *  cannot be uploaded at all, at any bitrate we're willing to ship. */
const UPLOAD_CEILING_BYTES = 500 * 1024 * 1024; // 500 MB

/** Compression timeout — 20 minutes for very large files. */
const COMPRESS_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Thrown when a master is still over the upload ceiling after being
 * compressed at the best bitrate its resolution can honestly take.
 *
 * The export handler catches this and re-renders at 1080p rather than
 * crushing the file further — a genuine 1080p export beats a 4K one
 * starved to an unwatchable bitrate.
 */
export class MasterTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly height: number,
  ) {
    super(
      `Master is ${(bytes / (1024 * 1024)).toFixed(1)} MB after compression at ${height}p — ` +
      `over the ${(UPLOAD_CEILING_BYTES / (1024 * 1024)).toFixed(0)} MB upload ceiling`,
    );
    this.name = "MasterTooLargeError";
  }
}

/** Bitrate ladder by output height. CRF drives quality; maxrate caps
 *  the peaks so the file size stays predictable. */
function bitrateLadderFor(height: number): { maxrate: string; bufsize: string; crf: string } {
  if (height >= 2000) return { maxrate: "22M", bufsize: "44M", crf: "24" }; // 4K UHD
  if (height >= 1400) return { maxrate: "10M", bufsize: "20M", crf: "26" }; // 1440p
  return { maxrate: "4M", bufsize: "8M", crf: "28" };                       // 1080p and below
}

/**
 * If the file exceeds COMPRESS_THRESHOLD_BYTES, re-encode it at a
 * bitrate appropriate to its resolution. Returns the (possibly new)
 * path to the file ready for upload.
 *
 * @param height Output height of the master. Defaults to 1080 so every
 *               existing two-argument call site keeps its old behaviour.
 * @throws MasterTooLargeError if the compressed file still exceeds the
 *         upload ceiling.
 */
export async function compressIfNeeded(
  filePath: string,
  /** Unused — retained so the positional signature stays stable for
   *  existing callers and their test mocks. */
  _tempDir: string,
  height = 1080
): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);

  if (stat.size <= COMPRESS_THRESHOLD_BYTES) {
    console.log(`[CompressVideo] ${sizeMB} MB — within threshold, skipping compression`);
    return filePath;
  }

  const { maxrate, bufsize, crf } = bitrateLadderFor(height);
  console.log(`[CompressVideo] ${sizeMB} MB exceeds ${(COMPRESS_THRESHOLD_BYTES / (1024 * 1024)).toFixed(0)} MB — compressing at ${height}p (crf ${crf}, maxrate ${maxrate})`);

  const compressedPath = filePath.replace(".mp4", "_compressed.mp4");

  await runFfmpeg([
    "-i", filePath,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", crf,
    "-maxrate", maxrate,
    "-bufsize", bufsize,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    compressedPath,
  ], COMPRESS_TIMEOUT_MS);

  const compStat = await fs.promises.stat(compressedPath);
  const compMB = (compStat.size / (1024 * 1024)).toFixed(1);
  console.log(`[CompressVideo] Compressed: ${sizeMB} MB → ${compMB} MB`);

  if (compStat.size > UPLOAD_CEILING_BYTES) {
    // Leave both files for the caller's cleanup; it owns tempDir.
    try { fs.unlinkSync(compressedPath); } catch { /* ignore */ }
    throw new MasterTooLargeError(compStat.size, height);
  }

  // Replace original with compressed version
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }

  return compressedPath;
}
