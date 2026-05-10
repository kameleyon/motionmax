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
 * Watermark obtrusiveness tier. EU AI Act Art. 50 requires the watermark
 * always be present; the tier only controls font size, opacity, and position.
 *   - "free": prominent center-bottom mark, 60% opacity
 *   - "paid": small bottom-right mark, 35% opacity
 */
export type WatermarkTier = "free" | "paid";

/** Build the ffmpeg drawtext filter spec for a given tier. */
function watermarkFilterSpec(brandMark: string, tier: WatermarkTier): string {
  const escaped = brandMark.replace(/'/g, "’").replace(/:/g, "\\:").replace(/\\/g, "\\\\");
  if (tier === "paid") {
    return `drawtext=text='${escaped}':fontsize=18:fontcolor=white@0.35:x=w-text_w-20:y=h-text_h-20:font=Sans`;
  }
  return `drawtext=text='${escaped}':fontsize=24:fontcolor=white@0.6:x=(w-text_w)/2:y=h-40:font=Sans`;
}

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
  watermarkTier: WatermarkTier = "free",
): Promise<void> {
  if (files.length === 0) throw new Error("concatWithCaptions: no files");

  const listPath = outputPath + ".concat.txt";
  const listContent = files
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.promises.writeFile(listPath, listContent, "utf-8");

  const fontsDirEsc = fontsDir.replace(/\\/g, "/").replace(/'/g, "'\\''");
  const assPathEsc = assPath.replace(/\\/g, "/").replace(/'/g, "'\\''");

  // Build video filter chain: captions + AI Act watermark (always-on per Art. 50)
  let vf = `ass='${assPathEsc}':fontsdir='${fontsDirEsc}'`;
  if (brandMark) {
    vf += `,${watermarkFilterSpec(brandMark, watermarkTier)}`;
  }

  console.log(`[ConcatScenes] Joining ${files.length} clips + captions${brandMark ? ` + AI mark "${brandMark}" (${watermarkTier})` : ""} (single pass)`);

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
  watermarkTier: WatermarkTier = "free",
): Promise<void> {
  if (files.length === 0) throw new Error("concatWithBrandMark: no files");

  const listPath = outputPath + ".concat.txt";
  const listContent = files
    .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.promises.writeFile(listPath, listContent, "utf-8");

  const vf = watermarkFilterSpec(brandMark, watermarkTier);

  console.log(`[ConcatScenes] Joining ${files.length} clips + AI mark "${brandMark}" (${watermarkTier})`);

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
