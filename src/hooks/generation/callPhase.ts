/**
 * Network layer for generation pipeline: session management and phase API calls.
 * Includes retry logic for transient network failures and token refresh.
 */
import { supabase } from "@/integrations/supabase/client";
import { sleep, DEFAULT_ENDPOINT } from "./types";

const LOG = "[Pipeline:Network]";

/** Get a fresh auth session token, refreshing if the current one is missing/expired */
export async function getFreshSession(): Promise<string> {
  console.log(LOG, "Requesting fresh session token");
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) {
    console.warn(LOG, "Session missing or expired, attempting refresh", error?.message);
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData.session) {
      console.error(LOG, "Session refresh failed:", refreshError?.message);
      throw new Error("Session expired. Please refresh the page and try again.");
    }
    console.log(LOG, "Session refreshed successfully");
    return refreshData.session.access_token;
  }
  return session.access_token;
}

/**
 * Call a backend phase endpoint with configurable timeout, retries, and fresh auth.
 * Retries up to 3 times for transient network failures and 503 errors.
 */
export async function callPhase(
  body: Record<string, unknown>,
  timeoutMs: number = 120000,
  endpoint: string = DEFAULT_ENDPOINT
): Promise<any> {
  const MAX_ATTEMPTS = 3;
  const phase = body.phase || "unknown";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.log(LOG, `Phase "${phase}" attempt ${attempt}/${MAX_ATTEMPTS}`, {
        endpoint,
        timeoutMs,
        bodyKeys: Object.keys(body),
      });

      const accessToken = await getFreshSession();

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${endpoint}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMessage = "Phase failed";
        try {
          const errorData = await response.json();
          errorMessage = errorData?.error || errorMessage;
        } catch {
          // ignore JSON parse failure
        }

        console.error(LOG, `Phase "${phase}" HTTP ${response.status}:`, errorMessage);

        if (response.status === 429) throw new Error("Rate limit exceeded. Please wait and try again.");
        if (response.status === 402) throw new Error("AI credits exhausted. Please add credits.");
        if (response.status === 401) throw new Error("Session expired. Please refresh the page and try again.");
        if (response.status === 503 && attempt < MAX_ATTEMPTS) {
          const delay = 800 * attempt;
          console.warn(LOG, `Phase "${phase}" got 503, retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        throw new Error(errorMessage);
      }

      const result = await response.json();
      console.log(LOG, `Phase "${phase}" completed successfully`, {
        success: result?.success,
        hasMore: result?.hasMore,
      });
      return result;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        console.error(LOG, `Phase "${phase}" timed out after ${timeoutMs / 1000}s`);
        throw new Error(`Request timed out after ${timeoutMs / 1000}s. Please try again.`);
      }

      const msg = error instanceof Error ? error.message : String(error);
      const isTransientFetch = msg.toLowerCase().includes("failed to fetch");
      if (attempt < MAX_ATTEMPTS && isTransientFetch) {
        const jitter = Math.floor(Math.random() * 250);
        const delay = 750 * attempt + jitter;
        console.warn(LOG, `Phase "${phase}" transient failure, retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      console.error(LOG, `Phase "${phase}" failed after ${attempt} attempt(s):`, msg);
      throw error;
    }
  }

  console.error(LOG, `Phase "${phase}" exhausted all ${MAX_ATTEMPTS} attempts`);
  throw new Error("Phase call failed after retries");
}
