import { supabase } from "./lib/supabase.js";
import { Job } from "./types/job.js";
import { handleGenerateVideo } from "./handlers/generateVideo.js";
import { handleImagesPhase } from "./handlers/handleImages.js";
import { handleAudioPhase } from "./handlers/handleAudio.js";
import { handleFinalizePhase } from "./handlers/handleFinalize.js";
import { handleExportVideo } from "./handlers/exportVideo.js";
import { handleRegenerateImage } from "./handlers/handleRegenerateImage.js";
import { handleRegenerateAudio } from "./handlers/handleRegenerateAudio.js";
import { writeSystemLog } from "./lib/logger.js";

/* ---- Concurrency guard: prevent re-processing the same job ---- */
const activeJobs = new Set<string>();
let busy = false;

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

    await (supabase as any)
      .from('video_generation_jobs')
      .update({
        status: 'completed',
        progress: 100,
        payload: finalPayload,
        result: finalPayload,       // also write result so pollWorkerJob always finds it
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
  if (busy) return; // Previous poll still running — skip this tick
  busy = true;
  pollCount++;
  try {
    // Only pick up PENDING jobs — never re-grab processing ones (avoids restart loops)
    const { data: jobs, error, status, statusText } = await supabase
      .from('video_generation_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    // Log every 12th poll (~60s) or when there's data/errors
    const shouldLog = pollCount % 12 === 1 || (jobs && jobs.length > 0) || error;
    if (shouldLog) {
      console.log(`[Worker] Poll #${pollCount}: HTTP ${status} ${statusText || ''}, jobs: ${jobs?.length ?? 'null'}, error: ${error ? JSON.stringify(error) : 'none'}`);
    }

    if (error) {
      console.error("[Worker] Poll error:", error.code, error.message);
      return;
    }

    if (jobs && jobs.length > 0) {
      const job = jobs[0] as Job;

      if (activeJobs.has(job.id)) {
        // Already processing this job — skip
        return;
      }

      console.log(`[Worker] Found job ${job.id} (type: ${job.task_type}, status: ${job.status})`);
      await processJob(job);
    }
  } catch (err) {
    console.error("[Worker] Polling exception:", err);
  } finally {
    busy = false;
  }
}

const POLL_INTERVAL_MS = 5000;

const MAX_RESTART_RETRIES = 3;

/** Run once at startup to verify DB connectivity and rescue orphaned jobs.
 *  Tracks retries via payload._restartCount — after 3 restarts, marks as failed. */
async function startupDiagnostic(): Promise<void> {
  try {
    const { count, error } = await supabase
      .from("video_generation_jobs")
      .select("id", { count: "exact", head: true });

    if (error) {
      console.error("[Worker] ❌ Startup diagnostic FAILED — cannot read video_generation_jobs:", error.code, error.message);
      return;
    }
    console.log(`[Worker] ✅ Startup diagnostic OK — video_generation_jobs has ${count ?? 0} total row(s)`);

    // Find all processing jobs (orphans from previous worker instance)
    const { data: processingRows } = await supabase
      .from("video_generation_jobs")
      .select("id, task_type, payload, created_at, updated_at")
      .eq("status", "processing")
      .order("created_at", { ascending: true });

    if (processingRows && processingRows.length > 0) {
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
}

console.log(`[Worker] MotionMax Render Worker started. Polling every ${POLL_INTERVAL_MS}ms.`);
startupDiagnostic().then(() => {
  pollQueue();
  setInterval(pollQueue, POLL_INTERVAL_MS);
});