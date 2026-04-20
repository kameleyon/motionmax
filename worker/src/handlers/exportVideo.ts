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
import { isEnabled } from "../lib/featureFlags.js";
import { writeSystemLog } from "../lib/logger.js";
import { wlog } from "../lib/workerLogger.js";
import { processScene, type ExportConfig } from "./export/sceneEncoder.js";
import { concatFiles, concatWithCaptions, concatWithBrandMark } from "./export/concatScenes.js";
// concatWithCrossfade is imported conditionally; crossfade is currently disabled
// (EXPORT_CROSSFADE_DURATION defaults to 0 and all project types force it to 0).
// The module is kept in source but excluded from the active import graph until
// crossfade is re-enabled via feature flag.
// import { concatWithCrossfade } from "./export/transitions.js";
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
import { runFfmpeg } from "./export/ffmpegCmd.js";

// ── Export concurrency guard ─────────────────────────────────────────
// Each ffmpeg export job can consume ~200 MB. On a 2 GB container that
// means at most ~8 jobs fit in theory, but cinematic exports are heavier.
// Cap simultaneous exports at 2 to prevent OOM; additional export jobs
// wait until a slot opens before entering the hot ffmpeg path.

/** Maximum number of export jobs allowed to run ffmpeg simultaneously. */
const MAX_EXPORT_JOBS = parseInt(process.env.MAX_EXPORT_JOBS || "2", 10);

/** How many export jobs are currently inside _runExport (i.e. running ffmpeg). */
let activeExportJobs = 0;

// ── Configuration ────────────────────────────────────────────────────

/** Scenes per batch — sequential (1) is safest for memory. */
const SCENE_BATCH_SIZE = parseInt(process.env.EXPORT_BATCH_SIZE || "3", 10);

/** Per-scene encoding timeout (ms). Default: 5 minutes per scene. */
const SCENE_TIMEOUT_MS = parseInt(process.env.EXPORT_SCENE_TIMEOUT_MS || "300000", 10);

/** Enable Ken Burns pan/zoom on still images. Default: true. */
const KEN_BURNS_ENABLED = (process.env.EXPORT_KEN_BURNS || "true").toLowerCase() !== "false";

/** Crossfade transition duration in seconds. 0 disables. Default: 0.5. */
const CROSSFADE_DURATION = parseFloat(process.env.EXPORT_CROSSFADE_DURATION || "0.5");

/** Crossfade transition timeout (ms). Default: 30 minutes. */
const CROSSFADE_TIMEOUT_MS = parseInt(process.env.EXPORT_CROSSFADE_TIMEOUT || "1800000", 10);

// AI_VIDEO_ENABLED is now resolved dynamically via isEnabled() at job time
// so it can be toggled via the feature_flags DB table without a worker redeploy.

/** Per-scene AI video timeout (ms). Default: 5 minutes. */
const AI_VIDEO_TIMEOUT_MS = parseInt(process.env.EXPORT_AI_VIDEO_TIMEOUT || "300000", 10);

/** Maximum wall-clock time for a single export job. Default: 90 minutes. */
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || "5400000", 10);

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
  wlog.debug(`${prefix}: ${scenes.length} scenes`, {
    component: "ExportVideo",
    sceneCount: scenes.length,
    scenes: scenes.map((s: any, i: number) => ({
      i,
      videoUrl: !!s.videoUrl,
      imageUrl: !!s.imageUrl,
      imageUrls: Array.isArray(s.imageUrls) ? s.imageUrls.filter(Boolean).length : 0,
      audioUrl: !!s.audioUrl,
    })),
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

// ── Scene checkpoint (crash-restart resilience) ──────────────────────
// Written after every batch so a Render restart can skip already-encoded scenes.

const CHECKPOINT_FILE = "checkpoint.json";

interface SceneCheckpoint {
  version: 1;
  jobId: string;
  /** Index → absolute path of encoded clip, or null if not yet encoded. */
  sceneResults: (string | null)[];
}

function readCheckpoint(tempDir: string, jobId: string): (string | null)[] | null {
  const p = path.join(tempDir, CHECKPOINT_FILE);
  try {
    if (!fs.existsSync(p)) return null;
    const raw: SceneCheckpoint = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (raw.version !== 1 || raw.jobId !== jobId) return null;
    // Validate that each recorded path still exists on disk
    return raw.sceneResults.map((fp) =>
      fp && fs.existsSync(fp) ? fp : null
    );
  } catch {
    return null;
  }
}

function writeCheckpoint(tempDir: string, jobId: string, sceneResults: (string | null)[]): void {
  const p = path.join(tempDir, CHECKPOINT_FILE);
  try {
    const data: SceneCheckpoint = { version: 1, jobId, sceneResults };
    fs.writeFileSync(p, JSON.stringify(data));
  } catch {
    // Non-fatal: next batch will overwrite anyway
  }
}

/** Fetch user plan and determine if watermark overlay is required. */
async function fetchNeedsWatermark(userId: string | undefined): Promise<boolean> {
  if (!userId) return true; // No user = treat as free
  const { data } = await supabase
    .from("subscriptions")
    .select("plan_name")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const paidPlans = ["creator", "starter", "professional", "studio", "enterprise"];
  return !paidPlans.includes(data?.plan_name ?? "");
}

/** Burn a drawtext watermark onto an existing video file (overwrites in-place). */
async function applyWatermarkOverlay(filePath: string, text: string, tempDir: string): Promise<void> {
  const escaped = text.replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/\\/g, "\\\\");
  const tmpOut = path.join(tempDir, `wm_${Date.now()}.mp4`);
  await runFfmpeg([
    "-i", filePath,
    "-vf", `drawtext=text='${escaped}':fontsize=24:fontcolor=white@0.5:x=(w-text_w)/2:y=h-50`,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22",
    "-c:a", "copy",
    "-movflags", "+faststart",
    tmpOut,
  ]);
  fs.renameSync(tmpOut, filePath);
}

/** Build ExportConfig from environment, feature flags, and payload. */
async function buildExportConfig(payload: any): Promise<ExportConfig> {
  const format = payload.format || "landscape";
  const { width, height } = getTargetResolution(format);

  // Env var EXPORT_AI_VIDEO still works as the legacy override; the DB flag is
  // also checked so operators can toggle without a redeploy.
  const envAiVideo = process.env.EXPORT_AI_VIDEO;
  const aiVideo = envAiVideo !== undefined
    ? envAiVideo.toLowerCase() === "true"
    : await isEnabled("ai_video_generation", false);

  return {
    width,
    height,
    fps: 24,
    kenBurns: KEN_BURNS_ENABLED,
    crossfadeDuration: CROSSFADE_DURATION,
    aiVideo,
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
  // ── Concurrency gate: queue the job until a slot is free ──────────
  // Poll every 5 s. The outer JOB_TIMEOUT_MS race still applies so
  // a job stuck in the queue too long is correctly failed by the worker.
  while (activeExportJobs >= MAX_EXPORT_JOBS) {
    wlog.debug("Waiting for export slot", { jobId, active: activeExportJobs, max: MAX_EXPORT_JOBS });
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
  }

  activeExportJobs++;
  wlog.info("Acquired export slot", { jobId, active: activeExportJobs, max: MAX_EXPORT_JOBS });

  try {
    return await Promise.race([
      _runExport(jobId, payload, userId),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Export job ${jobId} timed out after ${JOB_TIMEOUT_MS / 60000} minutes`)),
          JOB_TIMEOUT_MS
        )
      ),
    ]);
  } finally {
    activeExportJobs--;
    wlog.info("Released export slot", { jobId, active: activeExportJobs, max: MAX_EXPORT_JOBS });
  }
}

async function _runExport(
  jobId: string,
  payload: any,
  userId?: string
) {
  const log = wlog.child({ jobId, userId, component: "ExportVideo" });
  const { project_id } = payload;
  const restartCount = typeof payload._restartCount === "number" ? payload._restartCount : 0;
  const exportConfig = await buildExportConfig(payload);
  exportConfig.userId = userId;

  const needsWatermark = await fetchNeedsWatermark(userId);
  const watermarkText = needsWatermark ? "AI-Generated" : undefined;
  if (needsWatermark) {
    log.info("Free-tier user — watermark will be applied");
  }

  // If this job has been restarted after a crash, disable crossfade and Ken Burns
  // to prevent the same crash loop. Use the safest possible export path.
  if (restartCount > 0) {
    log.warn("Job restarted — disabling crossfade and Ken Burns for stability", { restartCount });
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
      log.warn("DB scenes unusable — using payload scenes", { projectId: project_id });
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
    exportConfig.crossfadeDuration = 0;
    exportConfig.kenBurns = false;
    log.info("Cinematic detected — direct concat, no Ken Burns");
  } else if (isSmartFlow) {
    exportConfig.crossfadeDuration = 0;
    exportConfig.kenBurns = false;
    exportConfig.aiVideo = false; // SmartFlow = static slides, no AI video
    log.info("SmartFlow detected — static images, no animation");
  } else {
    exportConfig.kenBurns = false;
    exportConfig.crossfadeDuration = 0;
    exportConfig.aiVideo = false; // doc2video / explainer = image-based, no AI video
    log.info("Standard project — direct concat, no Ken Burns, no crossfade");
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

  log.info("Export config", {
    resolution: `${exportConfig.width}x${exportConfig.height}`,
    kenBurns: exportConfig.kenBurns,
    aiVideo: exportConfig.aiVideo,
    crossfade: exportConfig.crossfadeDuration,
    batchSize: SCENE_BATCH_SIZE,
    sceneTimeoutSec: SCENE_TIMEOUT_MS / 1000,
  });

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
    const brandMark: string | undefined = payload.brandMark || payload.brand_mark || undefined;
    // Free-tier watermark takes precedence over user-supplied brand mark
    const effectiveBrandMark: string | undefined = watermarkText ?? brandMark;
    let asrPromise: Promise<(ASRSceneResult | null)[]> | null = null;

    if (captionStyle !== "none") {
      const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
      if (hyperealApiKey) {
        // Signing function for private storage buckets — generates 1hr signed URLs
        const signUrl = async (bucket: string, filePath: string): Promise<string | null> => {
          const { data, error } = await supabase.storage.from(bucket).createSignedUrl(filePath, 3600);
          if (error || !data?.signedUrl) {
            log.warn("Failed to sign URL", { bucket, filePath, error: error?.message });
            return null;
          }
          return data.signedUrl;
        };

        // Fire ASR for all scenes in parallel — runs while scenes encode
        const scenesWithAudio = scenes.map((s: any) => ({ audioUrl: s.audioUrl, voiceover: s.voiceover }));
        asrPromise = transcribeAllScenes(scenesWithAudio, hyperealApiKey, "en", signUrl).catch(err => {
          log.warn("ASR failed, will use estimation", { error: (err as Error).message });
          return scenes.map(() => null);
        });
        log.info("ASR transcription started in background", { sceneCount: scenes.length });
      }
    }

    // ── 1. Encode scenes in sequential batches ──────────────────────
    // Restore from checkpoint if this is a Render restart — skip already-encoded scenes.
    const checkpointed = readCheckpoint(tempDir, jobId);
    const sceneResults: (string | null)[] = checkpointed ?? new Array(scenes.length).fill(null);
    const sceneErrors: string[] = [];
    if (checkpointed) {
      const resumedCount = checkpointed.filter(Boolean).length;
      log.info("Restored scene checkpoint — skipping already-encoded scenes", {
        resumedCount, totalScenes: scenes.length,
      });
    }

    for (let start = 0; start < scenes.length; start += SCENE_BATCH_SIZE) {
      const end = Math.min(start + SCENE_BATCH_SIZE, scenes.length);
      const batch = [];

      for (let i = start; i < end; i++) {
        // Skip scenes already encoded in a previous run
        if (sceneResults[i] !== null) {
          log.debug("Skipping already-encoded scene", { sceneIdx: i });
          continue;
        }

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
          log.error("Scene encoding failed", { sceneIdx, error: msg, isTimeout });
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

      // Persist checkpoint so a Render restart can resume from this point
      writeCheckpoint(tempDir, jobId, sceneResults);
      log.info("Batch done", { batchStart: start, batchEnd: end - 1, progressPct: pct });
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

      // Dynamic import: only load transitions module when crossfade is actually used
      const { concatWithCrossfade } = await import("./export/transitions.js");
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
      } else if (effectiveBrandMark) {
        log.info("Applying watermark to crossfade output");
        await applyWatermarkOverlay(finalOutputPath, effectiveBrandMark, tempDir);
      }
    } else {
      // No crossfade — probe clips, then concat (with or without captions in ONE pass)

      // Probe each individual scene clip for exact durations BEFORE anything else
      const { probeDuration } = await import("./export/ffmpegCmd.js");
      const actualDurations: number[] = [];
      for (const clipPath of sceneResults) {
        if (clipPath) {
          const dur = await probeDuration(clipPath);
          actualDurations.push(dur);
        } else {
          actualDurations.push(10);
        }
      }

      if (captionStyle !== "none") {
        // ── SINGLE PASS: concat + caption burn ────────────────────────
        // Instead of: concat (re-encode) → caption burn (re-encode again)
        // We do: concat demuxer + ASS filter = ONE encode pass

        sceneProgress.overallMessage = "Syncing captions to audio...";
        await flushSceneProgress(jobId);
        await supabase.from("video_generation_jobs").update({ progress: 76, updated_at: new Date().toISOString() }).eq("id", jobId);

        const asrResults = asrPromise ? await asrPromise : null;

        const totalVideoDur = actualDurations.reduce((a, b) => a + b, 0);
        log.debug("Caption timing", { totalSec: totalVideoDur.toFixed(1), sceneDurations: actualDurations.map((d: number) => d.toFixed(1)) });

        const assContent = generateAssSubtitles(scenes, captionStyle, exportConfig.width, exportConfig.height, actualDurations, asrResults || undefined);

        if (assContent) {
          const assPath = await writeAssFile(assContent, tempDir);
          const fontsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../../fonts");

          sceneProgress.overallMessage = "Stitching video + burning captions...";
          await flushSceneProgress(jobId);
          await supabase.from("video_generation_jobs").update({ progress: 78, updated_at: new Date().toISOString() }).eq("id", jobId);

          await writeSystemLog({
            jobId, projectId: project_id, userId,
            category: "system_info",
            eventType: "concat_captions_started",
            message: `Concat + caption burn (single pass): ${clipPaths.length} clips, style=${captionStyle}`,
          });

          await concatWithCaptions(clipPaths, assPath, fontsDir, finalOutputPath, undefined, effectiveBrandMark);
          removeFiles(assPath);
          log.info("Concat + captions done in single pass", { captionStyle });
        } else if (effectiveBrandMark) {
          await concatWithBrandMark(clipPaths, effectiveBrandMark, finalOutputPath);
          log.info("Concat + brand mark (no captions)");
        } else {
          // ASS generation returned null, no brand — just stream-copy concat
          await writeSystemLog({
            jobId, projectId: project_id, userId,
            category: "system_info",
            eventType: "concat_started",
            message: `Stream-copy concat: ${clipPaths.length} clips (no captions)`,
          });
          await concatFiles(clipPaths, finalOutputPath, true);
        }
      } else if (effectiveBrandMark) {
        await concatWithBrandMark(clipPaths, effectiveBrandMark, finalOutputPath);
        log.info("Concat + brand mark (no captions)", { brandMark: effectiveBrandMark });
      } else {
        // ── NO CAPTIONS, NO BRAND: stream-copy concat (instant) ──
        await writeSystemLog({
          jobId, projectId: project_id, userId,
          category: "system_info",
          eventType: "concat_started",
          message: `Stream-copy concat: ${clipPaths.length} clips (no captions, no brand)`,
        });
        await concatFiles(clipPaths, finalOutputPath, true);
      }
    }

    // Free individual scene MP4s
    for (const f of clipPaths) removeFiles(f);

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

    // Success: clean up temp dir now that output is safely uploaded
    try {
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      log.warn("Temp cleanup skipped", { error: (cleanupErr as Error).message });
    }

    return { success: true, url: finalVideoUrl };
  } catch (error) {
    log.error("Export job failed", { error: error instanceof Error ? error.message : String(error) });

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
    log.warn("Temp dir preserved for restart", { tempDir });
    throw error;
  } finally {
    clearSceneProgress(jobId);
  }
}
