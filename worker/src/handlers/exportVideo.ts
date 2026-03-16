/**
 * Video export orchestrator.
 *
 * Coordinates scene encoding → concat → upload.
 * All ffmpeg calls go through child_process.execFile (export/ffmpegCmd)
 * using SIMPLE filters only — no -filter_complex anywhere — which
 * eliminates the "Error initializing complex filters" crash.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { processScene } from "./export/sceneEncoder.js";
import { concatFiles } from "./export/concatScenes.js";
import { uploadToSupabase, removeFiles } from "./export/storageHelpers.js";

/** Process ONE scene at a time — Render's 512MB can OOM with 2 parallel. */
const SCENE_BATCH_SIZE = 1;

/** Fetch scenes from the generations table as a fallback. */
async function fetchScenesFromDb(projectId: string): Promise<any[]> {
  const { data: gen, error } = await supabase
    .from("generations")
    .select("scenes")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !gen?.scenes) return [];
  return (gen.scenes as any[]).map((s: any) => {
    const { _meta, ...rest } = s;
    return rest;
  });
}

/** Check whether any scene has at least one downloadable URL. */
function hasUsableUrls(scenes: any[]): boolean {
  return scenes.some(
    (s) =>
      s.videoUrl ||
      s.imageUrl ||
      (Array.isArray(s.imageUrls) && s.imageUrls.some(Boolean))
  );
}

/** Log scene URLs for diagnostics. */
function logScenes(prefix: string, scenes: any[]): void {
  console.log(`[ExportVideo] ${prefix}: ${scenes.length} scenes`);
  scenes.forEach((s: any, i: number) => {
    console.log(
      `[ExportVideo]   ${i}: videoUrl=${!!s.videoUrl} imageUrl=${!!s.imageUrl}` +
        ` imageUrls=${Array.isArray(s.imageUrls) ? s.imageUrls.filter(Boolean).length : 0}` +
        ` audioUrl=${!!s.audioUrl}`
    );
  });
}

export async function handleExportVideo(
  jobId: string,
  payload: any,
  userId?: string
) {
  const { project_id } = payload;
  let scenes: any[] = Array.isArray(payload.scenes) ? payload.scenes : [];

  logScenes("Payload", scenes);

  // Fallback: fetch from DB when payload lacks usable URLs
  if (scenes.length === 0 || !hasUsableUrls(scenes)) {
    console.warn(`[ExportVideo] Payload unusable — fetching from DB for ${project_id}`);
    scenes = await fetchScenesFromDb(project_id);
    logScenes("DB", scenes);
  }

  if (scenes.length === 0) {
    throw new Error(`Export failed: no scenes for project ${project_id}`);
  }

  await writeSystemLog({
    jobId,
    projectId: project_id,
    userId,
    category: "system_info",
    eventType: "export_video_started",
    message: `Started video export for ${scenes.length} scenes (no complex filters)`,
  });

  const tempDir = path.join(os.tmpdir(), `motionmax_export_${jobId}`);
  const finalOutputPath = path.join(tempDir, "final_export.mp4");

  try {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    await supabase
      .from("video_generation_jobs")
      .update({ progress: 10, status: "processing" })
      .eq("id", jobId);

    // ── 1. Encode scenes in sequential batches ──────────────────────
    const sceneResults: (string | null)[] = new Array(scenes.length).fill(null);
    const sceneErrors: string[] = [];

    for (let start = 0; start < scenes.length; start += SCENE_BATCH_SIZE) {
      const end = Math.min(start + SCENE_BATCH_SIZE, scenes.length);
      const batch = [];
      for (let i = start; i < end; i++) {
        batch.push(processScene(i, scenes[i], tempDir));
      }

      const results = await Promise.allSettled(batch);
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.path) {
          sceneResults[r.value.index] = r.value.path;
        } else if (r.status === "rejected") {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          console.error(`[ExportVideo] Scene batch ${start}-${end} error:`, msg);
          sceneErrors.push(msg);
        }
      }

      const pct = Math.floor(10 + (end / scenes.length) * 50);
      await supabase.from("video_generation_jobs").update({ progress: pct }).eq("id", jobId);
      console.log(`[ExportVideo] Batch ${start}-${end - 1} done (${pct}%)`);
    }

    const clipPaths = sceneResults.filter((p): p is string => p !== null);
    if (clipPaths.length === 0) {
      const detail =
        sceneErrors.length > 0
          ? `All ${scenes.length} scene(s) failed. First error: ${sceneErrors[0]}`
          : `${scenes.length} scene(s) had no downloadable media.`;
      throw new Error(`Video export failed: ${detail}`);
    }

    await writeSystemLog({
      jobId,
      projectId: project_id,
      userId,
      category: "system_info",
      eventType: "export_download_complete",
      message: `Encoded ${clipPaths.length} scene clips`,
    });
    await supabase.from("video_generation_jobs").update({ progress: 60 }).eq("id", jobId);

    // ── 2. Concatenate via concat demuxer (NO complex filters) ──────
    await writeSystemLog({
      jobId,
      projectId: project_id,
      userId,
      category: "system_info",
      eventType: "ffmpeg_stitch_started",
      message: "Starting concat demuxer stitch (no filter_complex)",
    });
    await concatFiles(clipPaths, finalOutputPath, true); // stream-copy: all scenes use same codec

    // Free individual scene MP4s
    for (const f of clipPaths) removeFiles(f);

    await supabase.from("video_generation_jobs").update({ progress: 90 }).eq("id", jobId);

    // ── 3. Upload final video ───────────────────────────────────────
    const finalFileName = `export_${project_id}_${Date.now()}.mp4`;
    const finalVideoUrl = await uploadToSupabase(finalOutputPath, finalFileName);

    await writeSystemLog({
      jobId,
      projectId: project_id,
      userId,
      category: "system_info",
      eventType: "export_video_completed",
      message: "Video exported successfully (concat demuxer)",
    });

    return { success: true, url: finalVideoUrl };
  } catch (error) {
    console.error(`[ExportVideo] Job ${jobId} failed:`, error);
    await writeSystemLog({
      jobId,
      projectId: project_id,
      userId,
      category: "system_error",
      eventType: "export_video_failed",
      message: "Video export failed",
      details: { error: error instanceof Error ? error.message : "Unknown" },
    });
    throw error;
  } finally {
    try {
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[ExportVideo] Temp cleanup skipped:`, (cleanupErr as Error).message);
    }
  }
}
