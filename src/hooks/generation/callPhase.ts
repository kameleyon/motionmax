import { supabase } from "@/integrations/supabase/client";
import { sleep, DEFAULT_ENDPOINT } from "./types";
import { SUPABASE_URL } from "@/lib/supabaseUrl";

const LOG = "[Pipeline:Network]";

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

export async function callPhase(
  body: Record<string, unknown>,
  timeoutMs: number = 300000, // 5 minutes max wait for video to render
  endpoint: string = DEFAULT_ENDPOINT
): Promise<any> {
  // Route all calls through direct Edge Function HTTP path.
  // Worker queue path (Render) is not yet active.
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
      console.log(LOG, "Dispatching edge function request", {
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

      console.log(LOG, "Edge function responded", {
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

        console.error(LOG, "Edge function request failed", {
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
          console.warn(LOG, "Retrying after transient 503 response", { requestId, attempt, endpoint, phase });
          await sleep(800 * attempt);
          continue;
        }
        throw new Error(errorMessage);
      }

      const result = await response.json();
      console.log(LOG, "Edge function request succeeded", {
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
      console.error(LOG, "Edge function request threw", {
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
        console.error(LOG, "Browser fetch failed before a usable response was returned", {
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
        console.warn(LOG, "Retrying after network/fetch failure", {
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
