/**
 * Video export orchestrator.
 *
 * Coordinates scene encoding → concat → upload.
 * All ffmpeg calls go through child_process.execFile (export/ffmpegCmd)
 * using SIMPLE filters only — no -filter_complex anywhere — which
 * eliminates the "Error initializing complex filters" crash.
 *
 * Features:
 *   • Per-scene progress tracking (written to job payload.sceneProgress)
 *   • Per-scene timeout guards (configurable via EXPORT_SCENE_TIMEOUT_MS)
 *   • Structured progress phases: encoding → concatenating → compressing → uploading
 */
import fs from "fs";
import path from "path";
import os from "os";
import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { processScene } from "./export/sceneEncoder.js";
import { concatFiles } from "./export/concatScenes.js";
import { compressIfNeeded } from "./export/compressVideo.js";
import { uploadToSupabase, removeFiles } from "./export/storageHelpers.js";
import {
  initSceneProgress,
  updateSceneProgress,
  flushSceneProgress,
  clearSceneProgress,
} from "../lib/sceneProgress.js";

/** Scenes per batch — sequential (1) is safest; slideshows spawn many ffmpeg
 *  sub-processes per scene, so even 2 parallel can OOM. */
const SCENE_BATCH_SIZE = parseInt(process.env.EXPORT_BATCH_SIZE || "1", 10);

/** Per-scene encoding timeout in ms. Default: 5 minutes per scene.
 *  Prevents a single broken scene from blocking the entire export. */
const SCENE_TIMEOUT_MS = parseInt(process.env.EXPORT_SCENE_TIMEOUT_MS || "300000", 10);

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

/**
 * Wrap a promise with a timeout. Rejects with a descriptive error if
 * the promise doesn't settle within the deadline.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

export async function handleExportVideo(
  jobId: string,
  payload: any,
  userId?: string
) {
  const { project_id } = payload;

  // ALWAYS fetch latest scenes from DB to pick up regenerated images/audio.
  // Payload scenes may be stale if a scene was regenerated after the export was queued.
  let scenes: any[] = await fetchScenesFromDb(project_id);
  logScenes("DB (fresh)", scenes);

  // Fallback to payload only if DB returned nothing
  if (scenes.length === 0 || !hasUsableUrls(scenes)) {
    const payloadScenes: any[] = Array.isArray(payload.scenes) ? payload.scenes : [];
    if (payloadScenes.length > 0 && hasUsableUrls(payloadScenes)) {
      console.warn(`[ExportVideo] DB scenes unusable — using payload scenes for ${project_id}`);
      scenes = payloadScenes;
      logScenes("Payload (fallback)", scenes);
    }
  }

  if (scenes.length === 0) {
    throw new Error(`Export failed: no scenes for project ${project_id}`);
  }

  // ── Initialize per-scene progress tracking ──────────────────────
  const sceneProgress = initSceneProgress(jobId, scenes.length, "encoding");
  await flushSceneProgress(jobId);

  await writeSystemLog({
    jobId,
    projectId: project_id,
    userId,
    category: "system_info",
    eventType: "export_video_started",
    message: `Started video export for ${scenes.length} scenes (batch=${SCENE_BATCH_SIZE}, timeout=${SCENE_TIMEOUT_MS / 1000}s/scene)`,
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
        // Mark scene as downloading/encoding
        await updateSceneProgress(jobId, i, "encoding", {
          message: `Encoding scene ${i + 1}/${scenes.length}`,
          flush: false,
        });

        // Wrap each scene with a timeout guard
        const scenePromise = withTimeout(
          processScene(i, scenes[i], tempDir),
          SCENE_TIMEOUT_MS,
          `Scene ${i + 1} encoding`
        );
        batch.push(scenePromise);
      }

      // Flush progress before starting the batch
      await flushSceneProgress(jobId);

      const results = await Promise.allSettled(batch);
      for (let idx = 0; idx < results.length; idx++) {
        const r = results[idx];
        const sceneIdx = start + idx;

        if (r.status === "fulfilled" && r.value.path) {
          sceneResults[r.value.index] = r.value.path;
          await updateSceneProgress(jobId, r.value.index, "complete", {
            message: `Scene ${r.value.index + 1} encoded successfully`,
            flush: false,
          });
        } else if (r.status === "fulfilled" && !r.value.path) {
          // Scene had no usable URLs — skipped
          await updateSceneProgress(jobId, r.value.index, "skipped", {
            message: `Scene ${r.value.index + 1} skipped — no media`,
            flush: false,
          });
        } else if (r.status === "rejected") {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          const isTimeout = msg.includes("timed out");
          console.error(`[ExportVideo] Scene ${sceneIdx} error:`, msg);
          sceneErrors.push(msg);

          await updateSceneProgress(jobId, sceneIdx, isTimeout ? "timeout" : "failed", {
            message: `Scene ${sceneIdx + 1} failed: ${msg}`,
            error: msg,
            flush: false,
          });
        }
      }

      const pct = Math.floor(10 + (end / scenes.length) * 50);
      await supabase.from("video_generation_jobs").update({ progress: pct }).eq("id", jobId);

      // Flush scene progress after each batch
      await flushSceneProgress(jobId);

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
      message: `Encoded ${clipPaths.length}/${scenes.length} scene clips (${sceneErrors.length} failed)`,
    });
    await supabase.from("video_generation_jobs").update({ progress: 60 }).eq("id", jobId);

    // ── 2. Concatenate via concat demuxer (NO complex filters) ──────

    // Update overall phase
    sceneProgress.overallPhase = "concatenating";
    sceneProgress.overallMessage = `Concatenating ${clipPaths.length} scene clips...`;
    await flushSceneProgress(jobId);

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

    await supabase.from("video_generation_jobs").update({ progress: 80 }).eq("id", jobId);

    // ── 3. Compress if too large for Supabase bucket ─────────────────

    sceneProgress.overallPhase = "compressing";
    sceneProgress.overallMessage = "Compressing final video if needed...";
    await flushSceneProgress(jobId);

    const uploadPath = await compressIfNeeded(finalOutputPath, tempDir);

    await supabase.from("video_generation_jobs").update({ progress: 90 }).eq("id", jobId);

    // ── 4. Upload final video ───────────────────────────────────────

    sceneProgress.overallPhase = "uploading";
    sceneProgress.overallMessage = "Uploading final video...";
    await flushSceneProgress(jobId);

    const finalFileName = `export_${project_id}_${Date.now()}.mp4`;
    const finalVideoUrl = await uploadToSupabase(uploadPath, finalFileName);

    // Mark complete
    sceneProgress.overallPhase = "complete";
    sceneProgress.overallMessage = `Export complete — ${clipPaths.length}/${scenes.length} scenes`;
    await flushSceneProgress(jobId);

    await writeSystemLog({
      jobId,
      projectId: project_id,
      userId,
      category: "system_info",
      eventType: "export_video_completed",
      message: `Video exported successfully — ${clipPaths.length}/${scenes.length} scenes (${sceneErrors.length} failed)`,
    });

    return { success: true, url: finalVideoUrl };
  } catch (error) {
    console.error(`[ExportVideo] Job ${jobId} failed:`, error);

    // Update scene progress with failure
    sceneProgress.overallPhase = "failed";
    sceneProgress.overallMessage = `Export failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    await flushSceneProgress(jobId);

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
    clearSceneProgress(jobId);
    try {
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[ExportVideo] Temp cleanup skipped:`, (cleanupErr as Error).message);
    }
  }
}
