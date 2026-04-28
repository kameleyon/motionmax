/**
 * Autopost run thumbnail generator.
 *
 * For each autopost run that has a rendered video, extract a single
 * 360×640 jpeg frame at duration/2 and upload it to the public
 * `autopost-thumbnails` storage bucket. Then update the run row with
 * the public URL + storage path so the lab UI can render it directly
 * without a signed URL roundtrip.
 *
 * Failure is *non-fatal*: the run is still considered successful even
 * if thumbnail generation fails. We log a warning and move on. The
 * dispatcher will not call us again for the same run because we guard
 * with `WHERE thumbnail_url IS NULL`.
 *
 * ffmpeg is invoked via the shared {@link runFfmpeg} helper from the
 * exporter — same binary, same error-shaping, no new dependency. The
 * worker host already has ffmpeg on PATH (used by the cinematic
 * exporter), so no Docker image change is needed.
 *
 * Output sizing: 360×640 keeps the file small (~12–25 KB jpeg, q=4)
 * and matches the 9:16 vertical aspect ratio of every supported
 * autopost target (YouTube Shorts, IG Reels, TikTok). The lab UI's
 * largest thumbnail box is 180×320, so 360×640 is exactly 2× — sharp
 * on retina without wasting bytes.
 */

import { promises as fsp } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { runFfmpeg, probeDuration } from "../export/ffmpegCmd.js";
import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";

const BUCKET = "autopost-thumbnails";
const THUMB_WIDTH = 360;
const THUMB_HEIGHT = 640;
/** ffmpeg -q:v scale (1=best, 31=worst). 4 yields ~25KB at 360×640. */
const JPEG_QUALITY = 4;
/** Cap to defend against probeDuration returning a bogus huge number. */
const MAX_SEEK_SECONDS = 600;

/**
 * Extract a poster frame from `videoUrl`, upload it to the public
 * thumbnails bucket, and persist the public URL + path on the
 * autopost_runs row.
 *
 * No-ops (and returns false) if a thumbnail already exists for this
 * run — caller doesn't need to pre-check, but pre-checking saves an
 * ffmpeg invocation.
 *
 * @returns true iff a new thumbnail was uploaded and the run row updated.
 */
export async function generateAutopostThumbnail(
  runId: string,
  videoUrl: string,
): Promise<boolean> {
  if (!runId || !videoUrl) return false;

  // Belt-and-suspenders: don't overwrite an existing thumbnail.
  try {
    const { data: existing } = await supabase
      .from("autopost_runs")
      .select("thumbnail_url")
      .eq("id", runId)
      .maybeSingle();
    if (existing && (existing as { thumbnail_url?: string | null }).thumbnail_url) {
      return false;
    }
  } catch {
    // Non-fatal — fall through and try to create one.
  }

  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `autopost-thumb-${runId}-${randomUUID()}.jpg`);

  try {
    // Best-effort midpoint seek. ffmpeg's seeking is fast on remote
    // URLs because we ask for a single frame after the seek.
    let seekSeconds = 1;
    try {
      const dur = await probeDuration(videoUrl);
      if (Number.isFinite(dur) && dur > 0) {
        seekSeconds = Math.min(Math.max(dur / 2, 0.5), MAX_SEEK_SECONDS);
      }
    } catch {
      // Probe failure is fine — fall back to t=1s.
      seekSeconds = 1;
    }

    // -ss before -i = fast seek (keyframe-accurate enough for a
    // single still). -frames:v 1 stops after the first decoded frame.
    // The scale filter forces 360×640; setsar=1 normalizes pixel ratio.
    await runFfmpeg(
      [
        "-ss", seekSeconds.toFixed(2),
        "-i", videoUrl,
        "-frames:v", "1",
        "-vf", `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:force_original_aspect_ratio=increase,crop=${THUMB_WIDTH}:${THUMB_HEIGHT},setsar=1`,
        "-q:v", String(JPEG_QUALITY),
        tmpFile,
      ],
      60_000,
    );

    const buffer = await fsp.readFile(tmpFile);
    const storagePath = `${runId}.jpg`;

    const { error: uploadErr } = await supabase
      .storage
      .from(BUCKET)
      .upload(storagePath, buffer, {
        contentType: "image/jpeg",
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadErr) {
      throw new Error(`storage upload failed: ${uploadErr.message}`);
    }

    const { data: publicData } = supabase
      .storage
      .from(BUCKET)
      .getPublicUrl(storagePath);

    const publicUrl = publicData?.publicUrl;
    if (!publicUrl) {
      throw new Error("getPublicUrl returned no URL");
    }

    const { error: updateErr } = await supabase
      .from("autopost_runs")
      .update({
        thumbnail_url: publicUrl,
        thumbnail_storage_path: storagePath,
      } as never)
      .eq("id", runId)
      .is("thumbnail_url", null);

    if (updateErr) {
      // Non-fatal — the asset is uploaded, the row just doesn't
      // reference it. Operators can repair via the storage path.
      console.warn(`[Autopost] thumbnail row update failed for ${runId}: ${updateErr.message}`);
    }

    await writeSystemLog({
      category: "system_info",
      eventType: "autopost_thumbnail_generated",
      message: `Generated thumbnail for autopost run ${runId}`,
      details: { autopost_run_id: runId, storagePath, publicUrl, seekSeconds },
    });

    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[Autopost] thumbnail generation failed for ${runId}: ${msg}`);
    try {
      await writeSystemLog({
        category: "system_warning",
        eventType: "autopost_thumbnail_failed",
        message: `Thumbnail generation failed for autopost run ${runId}`,
        details: { autopost_run_id: runId, error: msg },
      });
    } catch {
      /* swallow */
    }
    return false;
  } finally {
    // Best-effort cleanup; OS tmpfs gets reaped anyway.
    fsp.unlink(tmpFile).catch(() => undefined);
  }
}
