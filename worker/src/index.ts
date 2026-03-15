import { supabase } from "./lib/supabase.js";
import { Job } from "./types/job.js";
import { handleGenerateVideo } from "./handlers/generateVideo.js";
import { handleExportVideo } from "./handlers/exportVideo.js";
import { writeSystemLog } from "./lib/logger.js";

/* ---- Concurrency guard: prevent re-processing the same job ---- */
const activeJobs = new Set<string>();
let busy = false;

async function processJob(job: Job) {
  activeJobs.add(job.id);

  await writeSystemLog({
    jobId: job.id,
    projectId: job.project_id,
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
      await handleGenerateVideo(job.id, job.payload, job.user_id);
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
      projectId: job.project_id,
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
      projectId: job.project_id,
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

/** Run once at startup to verify DB connectivity and log table state. */
async function startupDiagnostic(): Promise<void> {
  try {
    const { count, error } = await supabase
      .from("video_generation_jobs")
      .select("id", { count: "exact", head: true });

    if (error) {
      console.error("[Worker] ❌ Startup diagnostic FAILED — cannot read video_generation_jobs:", error.code, error.message);
    } else {
      console.log(`[Worker] ✅ Startup diagnostic OK — video_generation_jobs has ${count ?? 0} total row(s)`);
    }

    // Check for any pending/processing rows right now
    const { data: pendingRows, error: pendingErr } = await supabase
      .from("video_generation_jobs")
      .select("id, status, created_at")
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: true })
      .limit(5);

    if (!pendingErr && pendingRows && pendingRows.length > 0) {
      console.log(`[Worker] 📋 Found ${pendingRows.length} pending/processing job(s) at startup:`,
        pendingRows.map((r: any) => ({ id: r.id, status: r.status, created_at: r.created_at }))
      );
    } else if (!pendingErr) {
      console.log("[Worker] 📋 No pending/processing jobs at startup.");
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