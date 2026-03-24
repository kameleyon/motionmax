import { supabase } from "./lib/supabase.js";
import { Job } from "./types/job.js";
import { handleGenerateVideo } from "./handlers/generateVideo.js";
import { handleImagesPhase } from "./handlers/handleImages.js";
import { handleAudioPhase } from "./handlers/handleAudio.js";
import { handleFinalizePhase } from "./handlers/handleFinalize.js";
import { handleExportVideo } from "./handlers/exportVideo.js";
import { handleRegenerateImage } from "./handlers/handleRegenerateImage.js";
import { handleRegenerateAudio } from "./handlers/handleRegenerateAudio.js";
import { handleCinematicVideo } from "./handlers/handleCinematicVideo.js";
import { handleCinematicAudio } from "./handlers/handleCinematicAudio.js";
import { handleCinematicImage } from "./handlers/handleCinematicImage.js";
import { handleUndoRegeneration } from "./handlers/handleUndoRegeneration.js";
import { writeSystemLog } from "./lib/logger.js";

/* ---- Concurrency guard: prevent re-processing the same job ---- */
const activeJobs = new Set<string>();
const MAX_CONCURRENT_JOBS = parseInt(process.env.WORKER_CONCURRENCY || "6", 10);

async function processJob(job: Job) {
  activeJobs.add(job.id);

  await writeSystemLog({
    jobId: job.id,
    projectId: job.project_id ?? undefined,
    userId: job.user_id,
    generationId: job.payload?.generation_id,
    category: "system_info",
    eventType: "job_started",
    message: `Worker picked up job ${job.id}`
  });
  
  let finalPayload = { ...job.payload };

  try {
    await supabase
      .from('video_generation_jobs')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', job.id);

    if (job.task_type === 'generate_video') {
      const scriptResult = await handleGenerateVideo(job.id, job.payload, job.user_id);
      // Merge result into finalPayload so both `payload` and `result` columns
      // carry the output — the frontend polls `payload` (old builds) or
      // `result` (new builds).
      if (scriptResult && typeof scriptResult === "object") {
        finalPayload = { ...finalPayload, ...scriptResult };
      }
    } else if (job.task_type === 'process_images' as any) {
      const imagesResult = await handleImagesPhase(job.id, job.payload as any, job.user_id);
      finalPayload = { ...finalPayload, ...imagesResult };
    } else if (job.task_type === 'process_audio' as any) {
      const audioResult = await handleAudioPhase(job.id, job.payload as any, job.user_id);
      finalPayload = { ...finalPayload, ...audioResult };
    } else if (job.task_type === 'finalize_generation' as any) {
      const finalizeResult = await handleFinalizePhase(job.id, job.payload as any, job.user_id);
      finalPayload = { ...finalPayload, ...finalizeResult };
    } else if (job.task_type === 'export_video' as any) {
      const exportResult = await handleExportVideo(job.id, job.payload, job.user_id);
      finalPayload.finalUrl = exportResult.url;
    } else if (job.task_type === 'regenerate_image' as any) {
      const regenResult = await handleRegenerateImage(job.id, job.payload as any, job.user_id);
      finalPayload = { ...finalPayload, ...regenResult };
    } else if (job.task_type === 'regenerate_audio' as any) {
      const audioRegenResult = await handleRegenerateAudio(job.id, job.payload as any, job.user_id);
      finalPayload = { ...finalPayload, ...audioRegenResult };
    } else if (job.task_type === 'cinematic_video' as any) {
      const result = await handleCinematicVideo(job.id, job.payload as any, job.user_id);
      finalPayload = { ...finalPayload, ...result };
    } else if (job.task_type === 'cinematic_audio' as any) {
      const result = await handleCinematicAudio(job.id, job.payload as any, job.user_id);
      finalPayload = { ...finalPayload, ...result };
    } else if (job.task_type === 'cinematic_image' as any) {
      const result = await handleCinematicImage(job.id, job.payload as any, job.user_id);
      finalPayload = { ...finalPayload, ...result };
    } else if (job.task_type === 'undo_regeneration' as any) {
      const result = await handleUndoRegeneration(job.id, job.payload as any, job.user_id);
      finalPayload = { ...finalPayload, ...result };
    } else {
      await writeSystemLog({
        jobId: job.id,
        userId: job.user_id,
        category: "system_warning",
        eventType: "unknown_task",
        message: `No handler for task type: ${job.task_type}`
      });
    }
    
    await writeSystemLog({
      jobId: job.id,
      projectId: job.project_id ?? undefined,
      userId: job.user_id,
      category: "system_info",
      eventType: "job_completed",
      message: `Worker successfully completed job ${job.id}`
    });

    // Strip restart bookkeeping before persisting
    const { _restartCount: _rc, ...cleanPayload } = finalPayload;

    await (supabase as any)
      .from('video_generation_jobs')
      .update({
        status: 'completed',
        progress: 100,
        payload: cleanPayload,
        result: cleanPayload,       // also write result so pollWorkerJob always finds it
        updated_at: new Date().toISOString()
      })
      .eq('id', job.id);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    
    await writeSystemLog({
      jobId: job.id,
      projectId: job.project_id ?? undefined,
      userId: job.user_id,
      category: "system_error",
      eventType: "job_failed",
      message: `Worker failed processing job ${job.id}: ${errorMsg}`,
      details: { stack: error instanceof Error ? error.stack : null }
    });
    
    await supabase
      .from('video_generation_jobs')
      .update({
        status: 'failed',
        error_message: errorMsg,
        updated_at: new Date().toISOString()
      })
      .eq('id', job.id);
  } finally {
    activeJobs.delete(job.id);
  }
}

let pollCount = 0;

async function pollQueue() {
  pollCount++;
  try {
    const availableSlots = MAX_CONCURRENT_JOBS - activeJobs.size;
    if (availableSlots <= 0) return;

    // Query for export jobs
    const { data: exportJobs, error: exportError } = await supabase
      .from('video_generation_jobs')
      .select('*')
      .eq('status', 'pending')
      .eq('task_type', 'export_video')
      .order('created_at', { ascending: true })
      .limit(availableSlots);

    if (exportError) {
      console.error("[Worker] Poll export error:", exportError.code, exportError.message);
    }

    // Query for generation jobs
    const { data: genJobs, error: genError } = await supabase
      .from('video_generation_jobs')
      .select('*')
      .eq('status', 'pending')
      .neq('task_type', 'export_video')
      .order('created_at', { ascending: true })
      .limit(availableSlots);

    if (genError) {
      console.error("[Worker] Poll generation error:", genError.code, genError.message);
    }

    const allJobs = [...(exportJobs || []), ...(genJobs || [])];
    
    // Sort by created_at to process oldest first, but we already have them separated
    allJobs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    // Take up to availableSlots
    const jobsToProcess = allJobs.slice(0, availableSlots);

    const shouldLog = pollCount % 12 === 1 || jobsToProcess.length > 0 || exportError || genError;
    if (shouldLog) {
      console.log(`[Worker] Poll #${pollCount}: jobs found: ${jobsToProcess.length}, active: ${activeJobs.size}/${MAX_CONCURRENT_JOBS}`);
    }

    for (const job of jobsToProcess) {
      if (activeJobs.has(job.id)) continue;
      console.log(`[Worker] Found job ${job.id} (type: ${job.task_type}, status: ${job.status})`);
      // Fire and forget
      processJob(job as Job).catch(err => {
        console.error(`[Worker] Unhandled error in processJob for ${job.id}:`, err);
      });
    }
  } catch (err) {
    console.error("[Worker] Polling exception:", err);
  }
}

const POLL_INTERVAL_MS = 2000;

const MAX_RESTART_RETRIES = 3;

/** Cooldown (ms) before first poll after recovering orphaned jobs.
 *  Prevents the crash-restart-pick-up-crash loop. */
const STARTUP_COOLDOWN_MS = 10_000;

/** Run once at startup to verify DB connectivity and rescue orphaned jobs.
 *  Tracks retries via payload._restartCount — after 3 restarts, marks as failed.
 *  Returns true if orphaned jobs were recovered (triggers cooldown). */
async function startupDiagnostic(): Promise<boolean> {
  let recoveredOrphans = false;
  try {
    const { count, error } = await supabase
      .from("video_generation_jobs")
      .select("id", { count: "exact", head: true });

    if (error) {
      console.error("[Worker] ❌ Startup diagnostic FAILED — cannot read video_generation_jobs:", error.code, error.message);
      return false;
    }
    console.log(`[Worker] ✅ Startup diagnostic OK — video_generation_jobs has ${count ?? 0} total row(s)`);

    // Find all processing jobs (orphans from previous worker instance)
    const { data: processingRows } = await supabase
      .from("video_generation_jobs")
      .select("id, task_type, payload, created_at, updated_at")
      .eq("status", "processing")
      .order("created_at", { ascending: true });

    if (processingRows && processingRows.length > 0) {
      recoveredOrphans = true;
      for (const row of processingRows as any[]) {
        const payload = (row.payload && typeof row.payload === "object") ? row.payload : {};
        const restartCount = (typeof payload._restartCount === "number" ? payload._restartCount : 0) + 1;

        if (restartCount > MAX_RESTART_RETRIES) {
          // Too many restarts — mark as failed to break the loop
          console.error(`[Worker] 🛑 Job ${row.id} exceeded ${MAX_RESTART_RETRIES} restart retries → marking FAILED`);
          await supabase
            .from("video_generation_jobs")
            .update({
              status: "failed",
              error_message: `Export failed after ${MAX_RESTART_RETRIES} worker restarts. The video may be too large for the current server. Please retry or try a shorter video.`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
        } else {
          // Reset to pending with incremented restart counter
          console.warn(`[Worker] ⚠️  Orphaned job: ${row.id} (${row.task_type}) restart #${restartCount} → resetting to pending`);
          await supabase
            .from("video_generation_jobs")
            .update({
              status: "pending",
              progress: 0,
              error_message: null,
              payload: { ...payload, _restartCount: restartCount },
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
        }
      }
    }

    // Show pending jobs remaining after cleanup
    const { data: pendingRows } = await supabase
      .from("video_generation_jobs")
      .select("id, status, task_type, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(5);

    if (pendingRows && pendingRows.length > 0) {
      console.log(`[Worker] 📋 ${pendingRows.length} job(s) queued:`,
        pendingRows.map((r: any) => ({ id: r.id, task_type: r.task_type, status: r.status }))
      );
    } else {
      console.log("[Worker] 📋 No pending jobs at startup.");
    }
  } catch (err) {
    console.error("[Worker] ❌ Startup diagnostic exception:", err);
  }
  return recoveredOrphans;
}

/* ---- Crash guard: prevent Node.js from dying on uncaught errors ---- */
process.on("uncaughtException", (err) => {
  console.error("[Worker] 💥 Uncaught exception (kept alive):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Worker] 💥 Unhandled rejection (kept alive):", reason);
});

console.log(`[Worker] MotionMax Render Worker started. Polling every ${POLL_INTERVAL_MS}ms.`);
startupDiagnostic().then((hadOrphans) => {
  if (hadOrphans) {
    console.log(`[Worker] ⏳ Cooldown ${STARTUP_COOLDOWN_MS / 1000}s before first poll (orphans recovered)`);
    setTimeout(() => {
      pollQueue();
      setInterval(pollQueue, POLL_INTERVAL_MS);
    }, STARTUP_COOLDOWN_MS);
  } else {
    pollQueue();
    setInterval(pollQueue, POLL_INTERVAL_MS);
  }
});