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
  timeoutMs: number = 300000, // 5 minutes max wait for video to render
  endpoint: string = DEFAULT_ENDPOINT
): Promise<any> {
  if (endpoint !== "generate-video") {
     return legacyCallPhase(body, timeoutMs, endpoint);
  }

  const phase = body.phase || "unknown";
  console.log(LOG, `[WORKER QUEUE] Firing job queue for generate-video. Phase: ${phase}`, body);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // Queue Job
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

  console.log(LOG, `[WORKER QUEUE] Job ${job.id} queued successfully. Connecting to Realtime...`);

  // Switch to Supabase Realtime instead of ugly HTTP polling intervals
  return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
          supabase.removeChannel(channel);
          reject(new Error(`Realtime WebSocket timed out after ${timeoutMs / 1000}s.`));
      }, timeoutMs);

      const channel = supabase
        .channel(`job_${job.id}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'video_generation_jobs',
            filter: `id=eq.${job.id}`
          },
          (payload) => {
            const updatedJob = payload.new;
            console.log(LOG, `[REALTIME] Job update: ${updatedJob.status} | Progress: ${updatedJob.progress}%`);
            
            if (updatedJob.status === "completed") {
                clearTimeout(timeoutId);
                supabase.removeChannel(channel);
                resolve({ success: true, hasMore: false, job: updatedJob, payload: updatedJob.payload });
            } else if (updatedJob.status === "failed") {
                clearTimeout(timeoutId);
                supabase.removeChannel(channel);
                reject(new Error(updatedJob.error_message || "Worker job failed during processing"));
            }
          }
        )
        .subscribe((status, err) => {
            if (status === 'SUBSCRIBED') {
                console.log(LOG, `[REALTIME] Successfully attached to job ${job.id} channel.`);
            } else if (status === 'CHANNEL_ERROR') {
                console.error(LOG, `[REALTIME] Connection dropped - fallback required.`, err);
                // Real system should fallback to interval polling here if WS fails
            }
        });
  });
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