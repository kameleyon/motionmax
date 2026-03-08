import { supabase } from "@/integrations/supabase/client";
import { sleep, DEFAULT_ENDPOINT } from "./types";

const LOG = "[Pipeline:Network]";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
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
