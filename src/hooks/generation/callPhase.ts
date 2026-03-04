import { supabase } from "@/integrations/supabase/client";
import { sleep, DEFAULT_ENDPOINT } from "./types";

const LOG = "[Pipeline:Network]";

export async function getFreshSession(): Promise<string> {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData.session) throw new Error("Session expired.");
    return refreshData.session.access_token;
  }
  return session.access_token;
}

export async function callPhase(
  body: Record<string, unknown>,
  timeoutMs: number = 120000,
  endpoint: string = DEFAULT_ENDPOINT
): Promise<any> {
  // If endpoint is not generate-video, keep using the standard edge function HTTP call.
  // Example: generate-cinematic, customer-portal, etc.
  if (endpoint !== "generate-video") {
     return legacyCallPhase(body, timeoutMs, endpoint);
  }

  // --- NEW WORKER QUEUE LOGIC ---
  const phase = body.phase || "unknown";
  console.log(LOG, `[WORKER QUEUE] Firing job queue for generate-video. Phase: ${phase}`, body);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Prevent multiple inserts if the app retries a phase loop
  // But for now, we drop the generation job ticket in DB:
  const { data: job, error: insertError } = await supabase
    .from("video_generation_jobs")
    .insert({
       project_id: body.projectId as string,
       user_id: user.id,
       task_type: "generate_video",
       payload: body,
       status: "pending"
    })
    .select()
    .single();

  if (insertError) {
      console.error(LOG, "Database insert failed:", insertError);
      throw new Error(`Failed to queue video job: ${insertError.message}`);
  }

  console.log(LOG, `[WORKER QUEUE] Job ${job.id} queued successfully. Polling for completion...`);

  // Start polling the DB table for progress instead of waiting on the HTTP buffer
  const startTime = Date.now();
  
  while ((Date.now() - startTime) < timeoutMs) {
      await sleep(2000); // Check every 2 seconds

      const { data: currentJob, error: checkError } = await supabase
        .from('video_generation_jobs')
        .select('*')
        .eq('id', job.id)
        .single();
        
      if (checkError) continue;

      // Realtime UI progress could be dispatched here based on currentJob.progress

      if (currentJob.status === "completed") {
         console.log(LOG, `[WORKER QUEUE] Job ${job.id} marked completed!`);
         // Return mock successful result mimicking Edge func for frontend parser
         return { success: true, hasMore: false, job: currentJob };
      }

      if (currentJob.status === "failed") {
          console.error(LOG, `[WORKER QUEUE] Job ${job.id} failed:`, currentJob.error_message);
          throw new Error(currentJob.error_message || "Worker job failed during processing");
      }
  }

  throw new Error(`Queue polling timed out after ${timeoutMs / 1000}s. The worker is still running!`);
}

// Fallback logic for non-video endpoints (cinematics, payments, etc.)
async function legacyCallPhase(body: Record<string, unknown>, timeoutMs: number, endpoint: string): Promise<any> {
  const MAX_ATTEMPTS = 3;
  const phase = body.phase || "unknown";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const accessToken = await getFreshSession();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMessage = "Phase failed";
        try { errorMessage = (await response.json())?.error || errorMessage; } catch {}
        if (response.status === 429) throw new Error("Rate limit exceeded.");
        if (response.status === 402) throw new Error("AI credits exhausted.");
        if (response.status === 401) throw new Error("Session expired.");
        if (response.status === 503 && attempt < MAX_ATTEMPTS) {
          await sleep(800 * attempt);
          continue;
        }
        throw new Error(errorMessage);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs / 1000}s.`);
      }
      const isTransientFetch = String(error).toLowerCase().includes("failed to fetch");
      if (attempt < MAX_ATTEMPTS && isTransientFetch) {
        await sleep(750 * attempt + Math.floor(Math.random() * 250));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Phase call failed after retries");
}