/**
 * Video export orchestrator.
 *
 * Coordinates scene encoding → crossfade transitions → compress → upload.
 *
 * Features:
 *   • Ken Burns pan/zoom on still images (configurable via EXPORT_KEN_BURNS)
 *   • Crossfade transitions between scenes (configurable via EXPORT_CROSSFADE_DURATION)
 *   • Per-scene progress tracking (written to job payload.sceneProgress)
 *   • Per-scene timeout guards (configurable via EXPORT_SCENE_TIMEOUT_MS)
 *   • Automatic fallback: crossfade → concat demuxer if filter_complex fails
 *   • All scene clips normalised to target resolution for transition compatibility
 */
import fs from "fs";
import path from "path";
import os from "os";
import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { processScene, type ExportConfig } from "./export/sceneEncoder.js";
import { concatFiles } from "./export/concatScenes.js";
import { concatWithCrossfade } from "./export/transitions.js";
import { compressIfNeeded } from "./export/compressVideo.js";
import { uploadToSupabase, removeFiles } from "./export/storageHelpers.js";
import { generateAssSubtitles, writeAssFile, type CaptionStyle, type ASRSceneResult } from "../services/captionBuilder.js";
import { transcribeAllScenes } from "../services/audioASR.js";
import { getTargetResolution } from "./export/kenBurns.js";
import {
  initSceneProgress,
  updateSceneProgress,
  flushSceneProgress,
  clearSceneProgress,
} from "../lib/sceneProgress.js";

// ── Configuration ────────────────────────────────────────────────────

/** Scenes per batch — sequential (1) is safest for memory. */
const SCENE_BATCH_SIZE = parseInt(process.env.EXPORT_BATCH_SIZE || "1", 10);

/** Per-scene encoding timeout (ms). Default: 5 minutes per scene. */
const SCENE_TIMEOUT_MS = parseInt(process.env.EXPORT_SCENE_TIMEOUT_MS || "300000", 10);

/** Enable Ken Burns pan/zoom on still images. Default: true. */
const KEN_BURNS_ENABLED = (process.env.EXPORT_KEN_BURNS || "true").toLowerCase() !== "false";

/** Crossfade transition duration in seconds. 0 disables. Default: 0.5. */
const CROSSFADE_DURATION = parseFloat(process.env.EXPORT_CROSSFADE_DURATION || "0.5");

/** Crossfade transition timeout (ms). Default: 30 minutes. */
const CROSSFADE_TIMEOUT_MS = parseInt(process.env.EXPORT_CROSSFADE_TIMEOUT || "1800000", 10);

/** Enable AI video generation per scene during export. Default: false. */
const AI_VIDEO_ENABLED = (process.env.EXPORT_AI_VIDEO || "false").toLowerCase() === "true";

/** Per-scene AI video timeout (ms). Default: 5 minutes. */
const AI_VIDEO_TIMEOUT_MS = parseInt(process.env.EXPORT_AI_VIDEO_TIMEOUT || "300000", 10);

// ── Helpers ──────────────────────────────────────────────────────────

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

/** Wrap a promise with a timeout. */
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

/** Build ExportConfig from environment and payload. */
function buildExportConfig(payload: any): ExportConfig {
  const format = payload.format || "landscape";
  const { width, height } = getTargetResolution(format);

  return {
    width,
    height,
    fps: 24,
    kenBurns: KEN_BURNS_ENABLED,
    crossfadeDuration: CROSSFADE_DURATION,
    aiVideo: AI_VIDEO_ENABLED,
    aiVideoTimeoutMs: AI_VIDEO_TIMEOUT_MS,
    aiTransitions: false,
    aiTransitionTimeoutMs: 0,
    format,
    projectId: payload.project_id,
    userId: undefined, // set in handler
  };
}

// ── Main Export Handler ──────────────────────────────────────────────

export async function handleExportVideo(
  jobId: string,
  payload: any,
  userId?: string
) {
  const { project_id } = payload;
  const restartCount = typeof payload._restartCount === "number" ? payload._restartCount : 0;
  const exportConfig = buildExportConfig(payload);
  exportConfig.userId = userId;

  // If this job has been restarted after a crash, disable crossfade and Ken Burns
  // to prevent the same crash loop. Use the safest possible export path.
  if (restartCount > 0) {
    console.warn(
      `[ExportVideo] Job restarted ${restartCount} time(s) — disabling crossfade and Ken Burns for stability`
    );
    exportConfig.crossfadeDuration = 0;
    exportConfig.kenBurns = false;
    exportConfig.aiVideo = false;
    exportConfig.aiTransitions = false;
  }

  // ALWAYS fetch latest scenes from DB to pick up regenerated images/audio.
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

  // Detect project type and adjust export config accordingly
  const projectType = payload.project_type || "";
  const isCinematic = scenes.some((s: any) => !!s.videoUrl);
  const isSmartFlow = projectType === "smartflow";

  if (isCinematic) {
    // Cinematic clips are self-contained — just concat directly, no transitions
    exportConfig.crossfadeDuration = 0;
    exportConfig.kenBurns = false;
    console.log(`[ExportVideo] Cinematic detected — direct concat, no Ken Burns`);
  } else if (isSmartFlow) {
    // SmartFlow = static image + voice, no animation at all
    exportConfig.crossfadeDuration = 0;
    exportConfig.kenBurns = false;
    console.log(`[ExportVideo] SmartFlow detected — static images, no animation`);
  } else {
    // Standard (storytelling/explainer): direct concat, no Ken Burns, no crossfade.
    // Crossfade uses pairwise re-encoding (N-1 passes) which destroys audio quality.
    exportConfig.kenBurns = false;
    exportConfig.crossfadeDuration = 0;
    console.log(`[ExportVideo] Standard project — direct concat, no Ken Burns, no crossfade`);
  }

  // ── Initialize per-scene progress tracking ──────────────────────
  const sceneProgress = initSceneProgress(jobId, scenes.length, "encoding");
  await flushSceneProgress(jobId);

  const features = [
    exportConfig.aiVideo ? "AI video" : exportConfig.kenBurns ? "Ken Burns" : "static",
    exportConfig.crossfadeDuration > 0 ? `${exportConfig.crossfadeDuration}s crossfade` : "hard cuts",
  ].join(", ");

  await writeSystemLog({
    jobId,
    projectId: project_id,
    userId,
    category: "system_info",
    eventType: "export_video_started",
    message: `Started video export: ${scenes.length} scenes, ${exportConfig.width}x${exportConfig.height}, ${features}`,
  });

  console.log(
    `[ExportVideo] Export config: ${exportConfig.width}x${exportConfig.height} | ` +
    `KenBurns=${exportConfig.kenBurns} | AI Video=${exportConfig.aiVideo} | ` +
    `Crossfade=${exportConfig.crossfadeDuration}s | ` +
    `Batch=${SCENE_BATCH_SIZE} | SceneTimeout=${SCENE_TIMEOUT_MS / 1000}s`
  );

  const tempDir = path.join(os.tmpdir(), `motionmax_export_${jobId}`);
  const finalOutputPath = path.join(tempDir, "final_export.mp4");

  try {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    await supabase
      .from("video_generation_jobs")
      .update({ progress: 10, status: "processing" })
      .eq("id", jobId);

    // ── 0.5. Start ASR transcription in parallel (for caption sync) ──
    const captionStyle = (payload.caption_style || "none") as CaptionStyle;
    let asrPromise: Promise<(ASRSceneResult | null)[]> | null = null;

    if (captionStyle !== "none") {
      const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
      if (hyperealApiKey) {
        // Signing function for private storage buckets — generates 1hr signed URLs
        const signUrl = async (bucket: string, filePath: string): Promise<string | null> => {
          const { data, error } = await supabase.storage.from(bucket).createSignedUrl(filePath, 3600);
          if (error || !data?.signedUrl) {
            console.warn(`[ExportVideo] Failed to sign URL for ${bucket}/${filePath}: ${error?.message}`);
            return null;
          }
          return data.signedUrl;
        };

        // Fire ASR for all scenes in parallel — runs while scenes encode
        const scenesWithAudio = scenes.map((s: any) => ({ audioUrl: s.audioUrl, voiceover: s.voiceover }));
        asrPromise = transcribeAllScenes(scenesWithAudio, hyperealApiKey, "en", signUrl).catch(err => {
          console.warn(`[ExportVideo] ASR failed, will use estimation: ${(err as Error).message}`);
          return scenes.map(() => null);
        });
        console.log(`[ExportVideo] ASR transcription started in background for ${scenes.length} scenes`);
      }
    }

    // ── 1. Encode scenes in sequential batches ──────────────────────
    const sceneResults: (string | null)[] = new Array(scenes.length).fill(null);
    const sceneErrors: string[] = [];

    for (let start = 0; start < scenes.length; start += SCENE_BATCH_SIZE) {
      const end = Math.min(start + SCENE_BATCH_SIZE, scenes.length);
      const batch = [];

      for (let i = start; i < end; i++) {
        await updateSceneProgress(jobId, i, "encoding", {
          message: `Encoding scene ${i + 1}/${scenes.length}`,
          flush: false,
        });

        const scenePromise = withTimeout(
          processScene(i, scenes[i], tempDir, exportConfig),
          SCENE_TIMEOUT_MS,
          `Scene ${i + 1} encoding`
        );
        batch.push(scenePromise);
      }

      await flushSceneProgress(jobId);

      const results = await Promise.allSettled(batch);
      for (let idx = 0; idx < results.length; idx++) {
        const r = results[idx];
        const sceneIdx = start + idx;

        if (r.status === "fulfilled" && r.value.path) {
          sceneResults[r.value.index] = r.value.path;
          await updateSceneProgress(jobId, r.value.index, "complete", {
            message: `Scene ${r.value.index + 1} encoded`,
            flush: false,
          });
        } else if (r.status === "fulfilled" && !r.value.path) {
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

      const pct = Math.floor(10 + (end / scenes.length) * 45);
      sceneProgress.overallMessage = `Encoding scenes ${end}/${scenes.length}...`;
      await flushSceneProgress(jobId);
      await supabase.from("video_generation_jobs").update({ progress: pct, updated_at: new Date().toISOString() }).eq("id", jobId);

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
      eventType: "export_scenes_encoded",
      message: `Encoded ${clipPaths.length}/${scenes.length} scene clips (${sceneErrors.length} failed)`,
    });
    await supabase.from("video_generation_jobs").update({ progress: 55 }).eq("id", jobId);

    // ── 2. Stitch scenes: crossfade or concat ───────────────────────

    sceneProgress.overallPhase = "concatenating";
    sceneProgress.overallMessage = exportConfig.crossfadeDuration > 0
      ? `Applying crossfade transitions to ${clipPaths.length} clips...`
      : `Concatenating ${clipPaths.length} scene clips...`;
    await flushSceneProgress(jobId);

    let usedCrossfade = false;

    if (exportConfig.crossfadeDuration > 0 && clipPaths.length >= 2) {
      await writeSystemLog({
        jobId,
        projectId: project_id,
        userId,
        category: "system_info",
        eventType: "crossfade_started",
        message: `Applying ${exportConfig.crossfadeDuration}s crossfade to ${clipPaths.length} clips`,
      });

      // Standard projects use fadeblack (clean fade to black between scenes)
      const transitionType = "fadeblack";

      usedCrossfade = await concatWithCrossfade(clipPaths, finalOutputPath, {
        duration: exportConfig.crossfadeDuration,
        transition: transitionType as any,
        pairTimeoutMs: CROSSFADE_TIMEOUT_MS,
        onPairComplete: async (completed, total) => {
          // Progress range for crossfade: 55% → 80%
          const pct = Math.floor(55 + (completed / total) * 25);
          sceneProgress.overallMessage = `Stitching scenes ${completed}/${total}...`;
          sceneProgress.overallPhase = "concatenating";
          // Update progress + message in payload together
          await flushSceneProgress(jobId);
          await supabase.from("video_generation_jobs")
            .update({ progress: pct, updated_at: new Date().toISOString() })
            .eq("id", jobId);
        },
      });

      if (!usedCrossfade) {
        await writeSystemLog({
          jobId,
          projectId: project_id,
          userId,
          category: "system_warning",
          eventType: "crossfade_fallback",
          message: "Crossfade failed — fell back to concat demuxer",
        });
      }
    } else {
      // No crossfade: use concat demuxer (re-encode for consistency)
      await writeSystemLog({
        jobId,
        projectId: project_id,
        userId,
        category: "system_info",
        eventType: "concat_started",
        message: `Concatenating ${clipPaths.length} clips (no transitions)`,
      });
      await concatFiles(clipPaths, finalOutputPath, false);
    }

    // Free individual scene MP4s
    for (const f of clipPaths) removeFiles(f);

    // ── 2.5. Burn captions into video (if requested) ───────────────

    if (captionStyle !== "none") {
      sceneProgress.overallMessage = "Syncing captions to audio...";
      await flushSceneProgress(jobId);
      await supabase.from("video_generation_jobs").update({ progress: 76, updated_at: new Date().toISOString() }).eq("id", jobId);

      // Await ASR results (already running in parallel since step 0.5)
      const asrResults = asrPromise ? await asrPromise : null;

      sceneProgress.overallMessage = "Burning captions into video...";
      await flushSceneProgress(jobId);
      await supabase.from("video_generation_jobs").update({ progress: 78, updated_at: new Date().toISOString() }).eq("id", jobId);

      // Probe the final video to get actual total duration
      const { probeDuration } = await import("./export/ffmpegCmd.js");
      const totalVideoDur = await probeDuration(finalOutputPath);
      const totalWords = scenes.reduce((sum: number, s: any) => sum + ((s.voiceover || "").split(/\s+/).length || 1), 0);
      const actualDurations = scenes.map((s: any) => {
        const words = (s.voiceover || "").split(/\s+/).length || 1;
        return (words / totalWords) * totalVideoDur;
      });
      console.log(`[ExportVideo] Caption timing: total=${totalVideoDur.toFixed(1)}s, scenes=${actualDurations.map((d: number) => d.toFixed(1)).join(",")}`);

      const assContent = generateAssSubtitles(scenes, captionStyle, exportConfig.width, exportConfig.height, actualDurations, asrResults || undefined);
      if (assContent) {
        const assPath = await writeAssFile(assContent, tempDir);
        const captionedPath = path.join(tempDir, "captioned_export.mp4");

        // Burn ASS subtitles into video using ffmpeg's ass filter
        // Resolve bundled Google Fonts directory for custom caption fonts
        const fontsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../../fonts");
        const fontsDirEsc = fontsDir.replace(/\\/g, "/").replace(/'/g, "'\\''");
        const assPathEsc = assPath.replace(/\\/g, "/").replace(/'/g, "'\\''");
        const { runFfmpeg } = await import("./export/ffmpegCmd.js");
        await runFfmpeg([
          "-i", finalOutputPath,
          "-vf", `ass='${assPathEsc}':fontsdir='${fontsDirEsc}'`,
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-crf", "23",
          "-pix_fmt", "yuv420p",
          "-c:a", "copy",
          "-movflags", "+faststart",
          captionedPath,
        ], 30 * 60 * 1000); // 30 min timeout for large videos

        // Replace the final output with the captioned version
        removeFiles(finalOutputPath);
        fs.renameSync(captionedPath, finalOutputPath);
        removeFiles(assPath);

        console.log(`[ExportVideo] Captions burned in (style: ${captionStyle})`);
      }
    }

    sceneProgress.overallMessage = "Scenes stitched. Compressing...";
    await flushSceneProgress(jobId);
    await supabase.from("video_generation_jobs").update({ progress: 80, updated_at: new Date().toISOString() }).eq("id", jobId);

    // ── 3. Compress if too large ────────────────────────────────────

    sceneProgress.overallPhase = "compressing";
    sceneProgress.overallMessage = "Compressing final video...";
    await flushSceneProgress(jobId);

    const uploadPath = await compressIfNeeded(finalOutputPath, tempDir);

    sceneProgress.overallMessage = "Uploading final video...";
    await flushSceneProgress(jobId);
    await supabase.from("video_generation_jobs").update({ progress: 90, updated_at: new Date().toISOString() }).eq("id", jobId);

    // ── 4. Upload final video ───────────────────────────────────────

    sceneProgress.overallPhase = "uploading";
    sceneProgress.overallMessage = "Uploading to cloud storage...";
    await flushSceneProgress(jobId);

    const finalFileName = `export_${project_id}_${Date.now()}.mp4`;
    const finalVideoUrl = await uploadToSupabase(uploadPath, finalFileName);

    // Mark complete
    sceneProgress.overallPhase = "complete";
    const transitionInfo = usedCrossfade ? " with crossfade transitions" : "";
    sceneProgress.overallMessage = `Export complete — ${clipPaths.length}/${scenes.length} scenes${transitionInfo}`;
    await flushSceneProgress(jobId);

    await writeSystemLog({
      jobId,
      projectId: project_id,
      userId,
      category: "system_info",
      eventType: "export_video_completed",
      message: `Video exported: ${clipPaths.length} scenes, ${features}, crossfade=${usedCrossfade}`,
    });

    return { success: true, url: finalVideoUrl };
  } catch (error) {
    console.error(`[ExportVideo] Job ${jobId} failed:`, error);

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
