import { supabase } from "@/integrations/supabase/client";
import { sleep, DEFAULT_ENDPOINT, CINEMATIC_ENDPOINT } from "./types";
import { SUPABASE_URL } from "@/lib/supabaseUrl";
import { createScopedLogger } from "@/lib/logger";

const log = createScopedLogger("CallPhase");

import { getCreditsRequired } from "@/lib/planLimits";

/** Deduct credits upfront before dispatching a generation job.
 *  Returns the number of credits deducted (for refund on failure). */
async function deductCreditsUpfront(projectType: string, length: string): Promise<number> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) throw new Error("Not authenticated");

  const type = (projectType || "doc2video") as "doc2video" | "storytelling" | "smartflow" | "cinematic";
  const amount = getCreditsRequired(type, length || "short");

  log.debug(`Deducting ${amount} credits upfront (${projectType}/${length})`);

  const { data: success, error } = await supabase.rpc("deduct_credits_securely", {
    p_user_id: session.user.id,
    p_amount: amount,
    p_transaction_type: "generation",
    p_description: `${projectType} video generation (${length})`,
  });

  if (error || !success) {
    throw new Error("Insufficient credits. Please purchase more credits to continue.");
  }

  log.debug(`Credits deducted: ${amount}`);
  return amount;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}

function summarizeRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    keys: Object.keys(body),
    phase: body.phase || "unknown",
    projectType: body.projectType || "doc2video",
    generationId: isValidUUID(body.generationId) ? body.generationId : body.generationId || null,
    projectId: isValidUUID(body.projectId) ? body.projectId : body.projectId || null,
    contentLength: typeof body.content === "string" ? body.content.length : 0,
    hasBrandMark: Boolean(body.brandMark),
    hasPresenterFocus: Boolean(body.presenterFocus),
    hasCharacterDescription: Boolean(body.characterDescription),
    hasVoiceId: Boolean(body.voiceId),
    skipAudio: body.skipAudio || false,
  };
}

function summarizeResponsePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return { payloadType: typeof payload };
  }

  const data = payload as Record<string, unknown>;
  return {
    keys: Object.keys(data),
    generationId: isValidUUID(data.generationId) ? data.generationId : data.generationId || null,
    projectId: isValidUUID(data.projectId) ? data.projectId : data.projectId || null,
    status: data.status || null,
    title: typeof data.title === "string" ? data.title : null,
    sceneCount: Array.isArray(data.scenes) ? data.scenes.length : null,
    hasVideoUrl: Boolean(data.videoUrl),
    hasError: Boolean(data.error),
  };
}

export async function getFreshSession(): Promise<string> {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData.session) throw new Error("Session expired.");
    return refreshData.session.access_token;
  }
  return session.access_token;
}

/**
 * Route the script phase through the worker queue (Render / Node.js).
 * Inserts a row into `video_generation_jobs`, then polls until
 * the worker marks it completed or failed.
 */
async function workerCallPhase(
  body: Record<string, unknown>,
  taskType: string = "generate_video",
  pollTimeoutMs: number = 5 * 60 * 1000
): Promise<any> {
  // Use getSession() (local-storage read, no network round-trip) instead of
  // getUser() (makes an auth API call that can fail with "TypeError: Failed to fetch")
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) throw new Error("Not authenticated");

  const { data: job, error: insertError } = await supabase
    .from("video_generation_jobs")
    .insert({
      user_id: session.user.id,
      project_id: (body.projectId as string) ?? null,
      task_type: taskType,
      status: "pending",
      payload: body as any,
    })
    .select("id")
    .single();

  if (insertError || !job) {
    throw new Error(`Failed to queue job: ${insertError?.message}`);
  }

  log.debug("Job queued for worker", { jobId: job.id, taskType, phase: body.phase ?? null });

  return pollWorkerJob(job.id, pollTimeoutMs);
}

/**
 * Poll `video_generation_jobs` every 3 s until the worker marks the job
 * completed or failed.  Timeout is caller-supplied (default 8 minutes).
 */
async function pollWorkerJob(jobId: string, maxWaitMs: number = 8 * 60 * 1000): Promise<any> {
  const POLL_INTERVAL = 2000;
  const MAX_WAIT = maxWaitMs;
  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > MAX_WAIT) {
      throw new Error(`Worker job timed out after ${Math.round(MAX_WAIT / 60000)} minutes`);
    }

    await sleep(POLL_INTERVAL);

    // The DB has a `result` JSONB column written by the worker.
    // We cast through `as any` since the auto-generated types may lag.
    const { data: row, error: pollError } = await (supabase
      .from("video_generation_jobs") as any)
      .select("status, error_message, payload, result")
      .eq("id", jobId)
      .single();

    if (pollError) throw new Error(`Failed to poll job: ${pollError.message}`);

    const jobRow = row as any;

    if (jobRow.status === "completed") {
      log.debug("Worker job completed", {
        jobId,
        elapsedMs: Date.now() - startTime,
      });
      // The worker writes the script result into the `result` column.
      // If the types don't expose it, fall back to payload which the
      // worker index.ts also updates on completion.
      return jobRow.result ?? jobRow.payload;
    }

    if (jobRow.status === "failed") {
      throw new Error(
        String(jobRow.error_message || "Script generation failed")
      );
    }

    // status is 'pending' or 'processing' — keep polling
  }
}

export async function callPhase(
  body: Record<string, unknown>,
  timeoutMs: number = 300000, // 5 minutes max wait for video to render
  endpoint: string = DEFAULT_ENDPOINT
): Promise<any> {
  // Script phase → worker queue
  if (body.phase === "script") {
    // Auto-detect cinematic from endpoint when projectType not explicitly set
    if (endpoint === CINEMATIC_ENDPOINT && !body.projectType) {
      body.projectType = "cinematic";
    }
    // Deduct credits upfront before creating the worker job
    const projectType = (body.projectType as string) || "doc2video";
    const length = (body.length as string) || "brief";
    let deductedAmount = 0;
    try {
      deductedAmount = await deductCreditsUpfront(projectType, length);
      return await workerCallPhase(body, "generate_video", 8 * 60 * 1000);
    } catch (err) {
      // Refund credits if the worker job failed after deduction
      if (deductedAmount > 0) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          await supabase.rpc("refund_credits", {
            p_user_id: session.user.id,
            p_amount: deductedAmount,
          }).catch(refundErr => log.error("CRITICAL: Refund failed after generation error", refundErr));
          log.debug(`Refunded ${deductedAmount} credits after generation failure`);
        }
      }
      throw err;
    }
  }

  // Cinematic video phase → worker queue
  if (body.phase === "video") {
    return workerCallPhase(body, "cinematic_video", 10 * 60 * 1000);
  }

  // Cinematic per-scene audio (has sceneIndex, endpoint is cinematic) → worker
  if (body.phase === "audio" && typeof body.sceneIndex === "number") {
    return workerCallPhase(body, "cinematic_audio", 5 * 60 * 1000);
  }

  // Cinematic per-scene images (has sceneIndex, endpoint is cinematic) → worker
  if (body.phase === "images" && typeof body.sceneIndex === "number") {
    return workerCallPhase(body, "cinematic_image", 5 * 60 * 1000);
  }

  // Images phase → worker queue (edge function times out at ~150s per chunk)
  if (body.phase === "images") {
    return workerCallPhase(body, "process_images", timeoutMs);
  }

  // Audio phase → worker queue (many providers, HC key rotation can take minutes)
  if (body.phase === "audio") {
    return workerCallPhase(body, "process_audio", timeoutMs);
  }

  // Finalize phase → worker queue (cost recording + status marking)
  if (body.phase === "finalize") {
    return workerCallPhase(body, "finalize_generation", 2 * 60 * 1000);
  }

  // Regeneration phases → worker queue (no edge-function timeout risk)
  if (body.phase === "regenerate-image") {
    return workerCallPhase(body, "regenerate_image", 3 * 60 * 1000);
  }

  if (body.phase === "regenerate-audio") {
    return workerCallPhase(body, "regenerate_audio", 3 * 60 * 1000);
  }

  if (body.phase === "undo") {
    return workerCallPhase(body, "undo_regeneration", 30 * 1000);
  }

  // Any remaining phase (unknown/legacy) → edge function
  return legacyCallPhase(body, timeoutMs, endpoint);
}

async function legacyCallPhase(body: Record<string, unknown>, timeoutMs: number, endpoint: string): Promise<any> {
  const MAX_ATTEMPTS = 3;
  const phase = body.phase || "unknown";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const requestStartedAt = Date.now();
    const requestId = `${endpoint}:${String(phase)}:${attempt}:${requestStartedAt}`;

    try {
      log.debug("Dispatching edge function request", {
        requestId,
        endpoint,
        attempt,
        timeoutMs,
        ...summarizeRequestBody(body),
      });

      const accessToken = await getFreshSession();
      const response = await fetch(`${SUPABASE_URL}/functions/v1/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      log.debug("Edge function responded", {
        requestId,
        endpoint,
        phase,
        attempt,
        elapsedMs: Date.now() - requestStartedAt,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type"),
        accessControlAllowOrigin: response.headers.get("access-control-allow-origin"),
      });

      if (!response.ok) {
        let errorMessage = "Phase failed";
        const rawErrorText = await response.text().catch(() => "");
        try {
          errorMessage = JSON.parse(rawErrorText)?.error || rawErrorText || errorMessage;
        } catch {
          errorMessage = rawErrorText || errorMessage;
        }

        log.error("Edge function request failed", {
          requestId,
          endpoint,
          phase,
          attempt,
          elapsedMs: Date.now() - requestStartedAt,
          status: response.status,
          errorMessage,
          rawErrorPreview: rawErrorText.substring(0, 500),
          accessControlAllowOrigin: response.headers.get("access-control-allow-origin"),
        });

        if (response.status === 429) throw new Error("Rate limit exceeded.");
        if (response.status === 402) throw new Error("AI credits exhausted.");
        if (response.status === 401) throw new Error("Session expired.");
        if (response.status === 503 && attempt < MAX_ATTEMPTS) {
          log.warn("Retrying after transient 503 response", { requestId, attempt, endpoint, phase });
          await sleep(800 * attempt);
          continue;
        }
        throw new Error(errorMessage);
      }

      const result = await response.json();
      log.debug("Edge function request succeeded", {
        requestId,
        endpoint,
        phase,
        attempt,
        elapsedMs: Date.now() - requestStartedAt,
        ...summarizeResponsePayload(result),
      });
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      const elapsedMs = Date.now() - requestStartedAt;
      log.error("Edge function request threw", {
        requestId,
        endpoint,
        phase,
        attempt,
        elapsedMs,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      });

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs / 1000}s.`);
      }

      const errorStr = String(error).toLowerCase();
      const isTransientFetch = errorStr.includes("failed to fetch");
      const isCorsGatewayTimeout = isTransientFetch && elapsedMs > 25000;

      if (isTransientFetch) {
        log.error("Browser fetch failed before a usable response was returned", {
          requestId,
          endpoint,
          phase,
          attempt,
          isCorsGatewayTimeout,
          note: isCorsGatewayTimeout
            ? "Likely a 504 Gateway Timeout from Supabase infrastructure. The edge function exceeded the gateway timeout limit. CORS headers are missing from 504 responses, causing the browser to report a CORS error."
            : "Browser-level network failure or transient CORS issue.",
        });
      }

      if (attempt < MAX_ATTEMPTS && isTransientFetch) {
        const backoffMs = isCorsGatewayTimeout
          ? 2000 * attempt + Math.floor(Math.random() * 1000)
          : 750 * attempt + Math.floor(Math.random() * 250);
        log.warn("Retrying after network/fetch failure", {
          requestId,
          endpoint,
          phase,
          attempt,
          backoffMs,
        });
        await sleep(backoffMs);
        continue;
      }

      if (isCorsGatewayTimeout) {
        throw new Error(
          `Server timed out processing the "${phase}" phase (${Math.round(elapsedMs / 1000)}s). ` +
          "This can happen with longer content or during high server load. Please try again."
        );
      }

      throw error;
    }
  }
  throw new Error("Phase call failed after retries");
}
