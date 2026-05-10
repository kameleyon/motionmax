/**
 * Structured DB logging for generate-video.
 *
 * Three sinks, all best-effort (errors are caught and logged, never thrown):
 *   - logApiCall({...}) → api_call_logs table — provider-level success/error
 *     records with cost, latency, queue/running time breakdown. Used for
 *     billing reconciliation and per-provider dashboards.
 *   - logSystemEvent({...}) → system_logs table — categorical event log
 *     (user_activity / system_error / system_warning / system_info). Each
 *     event also mirrors to the edge function console so it shows up in
 *     Supabase function logs alongside the persistent record.
 *   - logApiCallToSystem(supabase, userId, provider, model, status, details, ...)
 *     — convenience wrapper that emits a system_logs row with a uniform
 *     `api_{provider}_{status}` event_type. Use when the API call is
 *     instrumented through system_logs rather than api_call_logs.
 *
 * Notes:
 *   - `supabase` is typed `any` to match the original index.ts surface; the
 *     real client is the @supabase/supabase-js v2 instance from createClient.
 *   - All console output uses the same [API_LOG] / [SYSTEM_LOG] / category
 *     prefixes the worker pipeline depends on for log parsing.
 *
 * Extracted 2026-05-10 per audit C-4-2 (Arch C-A3). Zero behavior change.
 */

// ============= API CALL LOGGING =============
// OpenRouter is used for script generation with anthropic/claude-sonnet-4.6
// Replicate is used for image generation (google/nano-banana-2) and audio (Chatterbox)
export interface ApiCallLogParams {
  supabase: any;
  userId: string;
  generationId?: string;
  provider: "openrouter" | "replicate" | "google_tts" | "elevenlabs";
  model: string;
  status: "success" | "error" | "started";
  queueTimeMs?: number;
  runningTimeMs?: number;
  totalDurationMs: number;
  cost?: number;
  errorMessage?: string;
}

export async function logApiCall(params: ApiCallLogParams): Promise<void> {
  try {
    const {
      supabase,
      userId,
      generationId,
      provider,
      model,
      status,
      queueTimeMs,
      runningTimeMs,
      totalDurationMs,
      cost,
      errorMessage,
    } = params;

    const { error } = await supabase.from("api_call_logs").insert({
      user_id: userId,
      generation_id: generationId || null,
      provider,
      model,
      status,
      queue_time_ms: queueTimeMs || null,
      running_time_ms: runningTimeMs || null,
      total_duration_ms: totalDurationMs,
      cost: cost || 0,
      error_message: errorMessage || null,
    });

    if (error) {
      console.error(`[API_LOG] Failed to log API call: ${error.message}`);
    } else {
      console.log(
        `[API_LOG] Logged ${provider}/${model} call: ${status}, ${totalDurationMs}ms, $${(cost || 0).toFixed(4)}`,
      );
    }
  } catch (err) {
    console.error(`[API_LOG] Error logging API call:`, err);
  }
}

// ============= SYSTEM EVENT LOGGING =============
export interface SystemLogParams {
  supabase: any;
  userId?: string;
  eventType: string;
  category: "user_activity" | "system_error" | "system_warning" | "system_info";
  message: string;
  details?: Record<string, unknown>;
  generationId?: string;
  projectId?: string;
}

export async function logSystemEvent(params: SystemLogParams): Promise<void> {
  try {
    const { supabase, userId, eventType, category, message, details, generationId, projectId } = params;

    const { error } = await supabase.from("system_logs").insert({
      user_id: userId || null,
      event_type: eventType,
      category,
      message,
      details: details || null,
      generation_id: generationId || null,
      project_id: projectId || null,
    });

    if (error) {
      console.error(`[SYSTEM_LOG] Failed to log event: ${error.message}`);
    }
    // Always output to console as well for edge function logs
    console.log(`[${category.toUpperCase()}] ${eventType}: ${message}`);
  } catch (err) {
    console.error(`[SYSTEM_LOG] Error logging event:`, err);
  }
}

// Helper to log API calls to system_logs for visibility
export async function logApiCallToSystem(
  supabase: any,
  userId: string,
  provider: string,
  model: string,
  status: "started" | "success" | "error",
  details: Record<string, unknown>,
  generationId?: string,
  projectId?: string,
): Promise<void> {
  const category = status === "error" ? "system_error" : status === "started" ? "system_info" : "system_info";
  const eventType = `api_${provider}_${status}`;
  const message =
    status === "started"
      ? `${provider}/${model} API call started`
      : status === "success"
        ? `${provider}/${model} API call succeeded`
        : `${provider}/${model} API call failed`;

  await logSystemEvent({
    supabase,
    userId,
    eventType,
    category,
    message,
    details: { provider, model, status, ...details },
    generationId,
    projectId,
  });
}
