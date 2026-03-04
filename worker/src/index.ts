import { supabase } from "./lib/supabase.js";
import { Job } from "./types/job.js";
import { handleGenerateVideo } from "./handlers/generateVideo.js";

async function processJob(job: Job) {
  console.log(`[Worker] Started processing job ${job.id} for project ${job.project_id}`);
  
  try {
    await supabase
      .from('video_generation_jobs')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', job.id);

    console.log(`[Worker] Task type: ${job.task_type}`);
    
    if (job.task_type === 'generate_video') {
      await handleGenerateVideo(job.id, job.payload);
    } else {
      console.log(`[Worker] No handler for task type: ${job.task_type}`);
    }
    
    console.log(`[Worker] Completed job ${job.id}`);
    await supabase
      .from('video_generation_jobs')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', job.id);

  } catch (error) {
    console.error(`[Worker] Job ${job.id} failed:`, error);
    
    await supabase
      .from('video_generation_jobs')
      .update({ 
        status: 'failed', 
        error_message: error instanceof Error ? error.message : 'Unknown error',
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
      if (error.code !== '42P01') { // Ignore relation does not exist for now while we scaffold
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