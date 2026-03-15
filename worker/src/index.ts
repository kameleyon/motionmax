import { supabase } from "./lib/supabase.js";
import { Job } from "./types/job.js";
import { handleGenerateVideo } from "./handlers/generateVideo.js";
import { handleImagesPhase } from "./handlers/handleImages.js";
import { handleAudioPhase } from "./handlers/handleAudio.js";
import { handleFinalizePhase } from "./handlers/handleFinalize.js";
import { handleExportVideo } from "./handlers/exportVideo.js";
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

    await supabase
      .from('video_generation_jobs')
      .update({
          status: 'completed',
          progress: 100,
          payload: finalPayload,
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
    // Query for pending jobs AND stale processing jobs (orphaned by worker restart)
    const { data: jobs, error, status, statusText } = await supabase
      .from('video_generation_jobs')
      .select('*')
      .in('status', ['pending', 'processing'])
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

// Jobs stuck in 'processing' for longer than this are orphaned (worker crashed mid-run).
const STALE_JOB_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes

/** Run once at startup to verify DB connectivity and rescue stale jobs. */
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

    // Find all 'processing' jobs
    const { data: processingRows } = await supabase
      .from("video_generation_jobs")
      .select("id, status, created_at, updated_at, task_type")
      .eq("status", "processing")
      .order("created_at", { ascending: true });

    if (processingRows && processingRows.length > 0) {
      const now = Date.now();
      const staleIds: string[] = [];

      for (const row of processingRows as any[]) {
        const lastUpdated = new Date(row.updated_at || row.created_at).getTime();
        const age = now - lastUpdated;

        if (age > STALE_JOB_THRESHOLD_MS) {
          staleIds.push(row.id);
          console.warn(
            `[Worker] ⚠️  Stale job detected: ${row.id} (${row.task_type}, stuck ${Math.round(age / 60000)}min) → marking FAILED`,
          );
        }
      }

      if (staleIds.length > 0) {
        await supabase
          .from("video_generation_jobs")
          .update({ status: "failed", error_message: "Worker restarted — job was stuck in processing for too long. Please retry.", updated_at: new Date().toISOString() })
          .in("id", staleIds);
        console.log(`[Worker] 🧹 Cleared ${staleIds.length} stale job(s)`);
      }
    }

    // Show pending/processing jobs remaining after cleanup
    const { data: pendingRows } = await supabase
      .from("video_generation_jobs")
      .select("id, status, task_type, created_at")
      .in("status", ["pending", "processing"])
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