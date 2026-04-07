/**
 * Concatenate MP4 clips using the ffmpeg concat **demuxer**.
 *
 * Three modes:
 *   • streamCopy = true  → fast, safe for clips created with identical params
 *   • streamCopy = false → full re-encode, needed for final scene join
 *   • concatWithCaptions  → stream-copy concat + caption burn in ONE pass
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
        "-crf", "22",
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

/**
 * Concat + burn captions in ONE ffmpeg pass.
 * Stream-copies the concat demuxer into the ASS filter, avoiding a second full encode.
 * This replaces the two-step: concat → caption burn.
 *
 * @param files      Scene clip paths
 * @param assPath    Path to ASS subtitle file
 * @param fontsDir   Path to fonts directory
 * @param outputPath Final output video path
 * @param timeoutMs  FFmpeg timeout (default 30 min)
 */
export async function concatWithCaptions(
  files: string[],
  assPath: string,
  fontsDir: string,
  outputPath: string,
  timeoutMs = 30 * 60 * 1000,
  brandMark?: string,
): Promise<void> {
  if (files.length === 0) throw new Error("concatWithCaptions: no files");

  const listPath = outputPath + ".concat.txt";
  const listContent = files
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.promises.writeFile(listPath, listContent, "utf-8");

  const fontsDirEsc = fontsDir.replace(/\\/g, "/").replace(/'/g, "'\\''");
  const assPathEsc = assPath.replace(/\\/g, "/").replace(/'/g, "'\\''");

  // Build video filter chain: captions + optional brand mark
  let vf = `ass='${assPathEsc}':fontsdir='${fontsDirEsc}'`;
  if (brandMark) {
    const escaped = brandMark.replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/\\/g, "\\\\");
    vf += `,drawtext=text='${escaped}':fontsize=24:fontcolor=white@0.6:x=(w-text_w)/2:y=h-40:font=Sans`;
  }

  console.log(`[ConcatScenes] Joining ${files.length} clips + burning captions${brandMark ? ` + brand "${brandMark}"` : ""} (single pass)`);

  try {
    await runFfmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      ...X264_MEM_FLAGS,
      outputPath,
    ], timeoutMs);
  } finally {
    try { fs.unlinkSync(listPath); } catch { /* ignore */ }
  }
}

/**
 * Concat files with brand mark only (no captions).
 * Re-encodes to burn the drawtext overlay.
 */
export async function concatWithBrandMark(
  files: string[],
  brandMark: string,
  outputPath: string,
  timeoutMs = 30 * 60 * 1000,
): Promise<void> {
  if (files.length === 0) throw new Error("concatWithBrandMark: no files");

  const listPath = outputPath + ".concat.txt";
  const listContent = files
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.promises.writeFile(listPath, listContent, "utf-8");

  const escaped = brandMark.replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/\\/g, "\\\\");
  const vf = `drawtext=text='${escaped}':fontsize=24:fontcolor=white@0.6:x=(w-text_w)/2:y=h-40:font=Sans`;

  console.log(`[ConcatScenes] Joining ${files.length} clips + brand "${brandMark}"`);

  try {
    await runFfmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-ar", "44100",
      "-ac", "2",
      "-movflags", "+faststart",
      ...X264_MEM_FLAGS,
      outputPath,
    ], timeoutMs);
  } finally {
    try { fs.unlinkSync(listPath); } catch { /* ignore */ }
  }
}
