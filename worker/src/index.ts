import { supabase } from "./lib/supabase.js";
import { Job } from "./types/job.js";
import { handleGenerateVideo } from "./handlers/generateVideo.js";
import { writeSystemLog } from "./lib/logger.js";

async function processJob(job: Job) {
  await writeSystemLog({ 
    jobId: job.id, 
    projectId: job.project_id, 
    userId: job.user_id, 
    generationId: job.payload?.generation_id,
    category: "system_info", 
    eventType: "job_started", 
    message: `Worker picked up job ${job.id}` 
  });
  
  try {
    await supabase
      .from('video_generation_jobs')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', job.id);

    if (job.task_type === 'generate_video') {
      await handleGenerateVideo(job.id, job.payload, job.user_id);
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
      .update({ status: 'completed', progress: 100, updated_at: new Date().toISOString() })
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
  }
}

async function pollQueue() {
  try {
    const { data: jobs, error } = await supabase
      .from('video_generation_jobs')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      if (error.code !== '42P01') { 
          console.error("[Worker] Error polling queue:", error);
      }
      return;
    }

    if (jobs && jobs.length > 0) {
      const job = jobs[0] as Job;
      await processJob(job);
    }
  } catch (err) {
    console.error("[Worker] Polling exception:", err);
  }
}

const POLL_INTERVAL_MS = 5000;
setInterval(pollQueue, POLL_INTERVAL_MS);

console.log(`[Worker] MotionMax Render Worker started. Polling every ${POLL_INTERVAL_MS}ms.`);
pollQueue();