/**
 * Wav2Lip lipsync via Replicate (devxpy/cog-wav2lip).
 *
 * Why Wav2Lip instead of sync/lipsync-2:
 *   - ~30× cheaper. $0.0023/sec compute vs $0.06/sec. A 169s run drops
 *     from ~$10 to ~$0.40.
 *   - Reuses existing REPLICATE_API_KEY — no extra vendor account.
 *   - Fast: 1-3 min typical for a 3-min input.
 *   - Quality is "good not great" — older 2020-era model with visible
 *     mouth-region artifacts on close-ups. This is the same model
 *     CapCut's free tier (and most "free lipsync" tools online) use.
 *
 * The Replicate API is async-first:
 *   1. POST /v1/models/<owner>/<name>/predictions → returns prediction + id.
 *   2. GET /v1/predictions/<id> polled until status terminates.
 *   3. On `succeeded`, `output` is the URL of the synced MP4 (string).
 *
 * Auth: `REPLICATE_API_KEY` (Bearer token). Falls back to legacy
 *       `REPLICATE_API_TOKEN` for env compatibility with the autopost
 *       pipeline which uses both names historically.
 */

import { writeApiLog } from "../lib/logger.js";

const DEFAULT_BASE = "https://api.replicate.com/v1";
const POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_MAX_MS = 15 * 60 * 1000; // 15 min — wav2lip is fast, this is generous slack

// Stable wav2lip publisher on Replicate. We bind to the owner+name only
// (not a pinned version) so Replicate's auto-update picks bug fixes.
// If pinning becomes needed, set REPLICATE_WAV2LIP_VERSION env to a SHA.
const MODEL_OWNER = "devxpy";
const MODEL_NAME = "cog-wav2lip";

export type LipsyncModel = "lipsync-2" | "lipsync-2-pro";

export interface LipsyncOptions {
  videoUrl: string;            // publicly fetchable MP4 (Supabase signed URL works)
  audioUrl: string;            // publicly fetchable audio (MP3 or WAV)
  /** Kept for API compatibility with the old sync.so service signature.
   *  Wav2Lip has no tier; both values map to the same Replicate model. */
  model?: LipsyncModel;
  userId?: string | null;      // for api_call_logs attribution
  generationId?: string | null;
  signal?: AbortSignal;        // honors worker's hard-timeout abort
  pollMaxMs?: number;
}

export interface LipsyncResult {
  videoUrl: string | null;
  durationSeconds?: number;
  provider: string;
  model: LipsyncModel;
  error?: string;
}

type PredictionStatus = "starting" | "processing" | "succeeded" | "failed" | "canceled";

interface PredictionResponse {
  id: string;
  status: PredictionStatus;
  /** Replicate output shapes vary by model:
   *   string url (legacy), array of urls, or { url } (File-typed). */
  output?: string | string[] | { url?: string } | null;
  error?: string | null;
  metrics?: { predict_time?: number };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Best-effort URL extraction across Replicate's three output shapes. */
function extractOutputUrl(output: PredictionResponse["output"]): string | null {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const first = output[0];
    return typeof first === "string" ? first : null;
  }
  if (typeof output === "object" && typeof output.url === "string") return output.url;
  return null;
}

export async function generateLipsync(opts: LipsyncOptions): Promise<LipsyncResult> {
  const apiKey = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_TOKEN;
  const base = process.env.REPLICATE_API_BASE || DEFAULT_BASE;
  const model: LipsyncModel = opts.model ?? "lipsync-2";
  const provider = "replicate";

  if (!apiKey) {
    return { videoUrl: null, provider, model, error: "REPLICATE_API_KEY is not configured" };
  }

  const startTime = Date.now();
  const pollMaxMs = opts.pollMaxMs ?? DEFAULT_POLL_MAX_MS;

  // ── 1. Submit the prediction ─────────────────────────────────────
  let predictionId: string;
  try {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "Wav2Lip aborted before submission" };
    }

    const submitRes = await fetch(`${base}/models/${MODEL_OWNER}/${MODEL_NAME}/predictions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          // devxpy/cog-wav2lip field names. `face` is the video that
          // contains the face to re-sync; `audio` is what the face
          // should now say. We pass Supabase signed URLs for both —
          // Replicate fetches them server-side, so they only need to
          // be publicly resolvable (signed URLs are fine).
          face: opts.videoUrl,
          audio: opts.audioUrl,
        },
      }),
      signal: opts.signal,
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => "");
      const err = `Wav2Lip submit ${submitRes.status}: ${errText.substring(0, 200)}`;
      console.warn(`[Wav2Lip] ${err}`);
      return { videoUrl: null, provider, model, error: err };
    }

    const created = (await submitRes.json()) as PredictionResponse;
    if (!created?.id) {
      return { videoUrl: null, provider, model, error: "Wav2Lip response missing prediction id" };
    }
    predictionId = created.id;
    console.log(`[Wav2Lip] Submitted prediction ${predictionId} (model=${MODEL_OWNER}/${MODEL_NAME})`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { videoUrl: null, provider, model, error: "Wav2Lip aborted by hard-timeout signal" };
    }
    return {
      videoUrl: null,
      provider,
      model,
      error: `Wav2Lip submit threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── 2. Poll until terminal or timeout ─────────────────────────────
  const pollDeadline = Date.now() + pollMaxMs;
  let lastStatus: PredictionStatus | "" = "";

  while (Date.now() < pollDeadline) {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "Wav2Lip poll aborted by hard-timeout signal" };
    }

    try {
      const pollRes = await fetch(`${base}/predictions/${predictionId}`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: opts.signal,
      });
      if (!pollRes.ok) {
        if (pollRes.status >= 400 && pollRes.status < 500 && pollRes.status !== 429) {
          const errText = await pollRes.text().catch(() => "");
          return {
            videoUrl: null, provider, model,
            error: `Wav2Lip poll ${pollRes.status}: ${errText.substring(0, 200)}`,
          };
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const body = (await pollRes.json()) as PredictionResponse;
      if (body.status !== lastStatus) {
        console.log(`[Wav2Lip] Prediction ${predictionId} status=${body.status}`);
        lastStatus = body.status;
      }

      if (body.status === "succeeded") {
        const outputUrl = extractOutputUrl(body.output);
        if (!outputUrl) {
          return { videoUrl: null, provider, model, error: "Wav2Lip succeeded but no output URL" };
        }
        const durationSeconds = body.metrics?.predict_time;
        writeApiLog({
          userId: opts.userId ?? null,
          generationId: opts.generationId ?? null,
          provider, model: `${MODEL_OWNER}/${MODEL_NAME}`,
          status: "success",
          totalDurationMs: Date.now() - startTime,
          cost: lipsyncCostUsd(durationSeconds ?? 0),
          error: undefined,
        }).catch((e) => console.warn(`[Wav2Lip] api log failed: ${(e as Error).message}`));

        return { videoUrl: outputUrl, durationSeconds, provider, model };
      }

      if (body.status === "failed" || body.status === "canceled") {
        return {
          videoUrl: null, provider, model,
          error: `Wav2Lip ${body.status}: ${body.error ?? "no reason given"}`,
        };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { videoUrl: null, provider, model, error: "Wav2Lip poll aborted by hard-timeout signal" };
      }
      console.warn(`[Wav2Lip] Poll exception (will retry): ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Best-effort cancel on timeout.
  cancelPrediction(base, apiKey, predictionId).catch((e) =>
    console.warn(`[Wav2Lip] cancel failed for ${predictionId}: ${(e as Error).message}`),
  );

  writeApiLog({
    userId: opts.userId ?? null,
    generationId: opts.generationId ?? null,
    provider, model: `${MODEL_OWNER}/${MODEL_NAME}`,
    status: "error",
    totalDurationMs: Date.now() - startTime,
    cost: 0,
    error: `Wav2Lip prediction poll timeout after ${Math.round(pollMaxMs / 1000)}s`,
  }).catch((e) => console.warn(`[Wav2Lip] api log failed: ${(e as Error).message}`));

  return {
    videoUrl: null, provider, model,
    error: `Wav2Lip prediction ${predictionId} did not complete within ${Math.round(pollMaxMs / 1000)}s`,
  };
}

async function cancelPrediction(base: string, apiKey: string, id: string): Promise<void> {
  const res = await fetch(`${base}/predictions/${id}/cancel`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`[Wav2Lip] cancel returned ${res.status} for ${id}`);
  } else {
    console.log(`[Wav2Lip] Cancelled prediction ${id}`);
  }
}

/** USD cost — Replicate bills wav2lip by predict_time on a T4 GPU
 *  (~$0.000225/sec). A 169s input is typically ~50-100s of predict_time,
 *  so total cost lands at $0.01–$0.02 / run. */
function lipsyncCostUsd(predictSeconds: number): number {
  return Math.max(0, predictSeconds * 0.000225);
}
