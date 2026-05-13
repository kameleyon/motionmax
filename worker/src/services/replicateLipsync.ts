/**
 * Replicate lipsync integration (sync/lipsync-2 model family).
 *
 * Why Replicate instead of sync.so direct:
 *   - The worker already has REPLICATE_API_KEY for other models (Hypereal
 *     fallback, Nano Banana, Seedance). One vendor = one billing
 *     dashboard, one outage page, one set of rate-limit knobs.
 *   - Replicate's prediction API is well-trodden in this worker — same
 *     polling pattern as the existing video integrations.
 *
 * Models:
 *   - sync/lipsync-2          (~$0.06 / output-second)
 *   - sync/lipsync-2-pro      (~$0.15 / output-second, sharper teeth + tongue)
 *
 * The Replicate API is async-first:
 *   1. POST /v1/models/<owner>/<name>/predictions → returns prediction + id.
 *   2. GET /v1/predictions/<id> polled until status terminates.
 *   3. On `succeeded`, `output` is the URL of the synced MP4.
 *
 * Auth: `REPLICATE_API_KEY` (Bearer token).
 */

import { writeApiLog } from "../lib/logger.js";

const DEFAULT_BASE = "https://api.replicate.com/v1";
const POLL_INTERVAL_MS = 3_000;
// Replicate's sync/lipsync-2 queue + compute can legitimately reach 20+ min
// on a 3-min input during peak hours (verified 2026-05-13 against prediction
// k2ajsp60jxrmr0cy46xr6jhv94 which hit our previous 10-min cap). 25 min
// matches the cinematic_video timeout pattern and gives queue depth + cold
// starts + compute enough room.
const DEFAULT_POLL_MAX_MS = 25 * 60 * 1000; // 25 min

export type LipsyncModel = "lipsync-2" | "lipsync-2-pro";

/** Replicate model owner — both lipsync-2 + lipsync-2-pro live under sync/. */
const MODEL_OWNER = "sync";

export interface ReplicateLipsyncOptions {
  videoUrl: string;            // publicly fetchable MP4 (Supabase signed URL works)
  audioUrl: string;            // publicly fetchable audio (WAV or MP3)
  model?: LipsyncModel;
  userId?: string | null;      // for api_call_logs attribution
  generationId?: string | null;
  signal?: AbortSignal;        // honors worker's hard-timeout abort
  pollMaxMs?: number;
}

export interface ReplicateLipsyncResult {
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
  /** Replicate's output shape varies by model generation:
   *   - Legacy: bare URL string `"https://replicate.delivery/.../out.mp4"`
   *   - List   : `["url1", "url2"]` (first element wins for single-output)
   *   - File   : `{ url: "..." }` — newer File-typed outputs that the JS SDK
   *              wraps as `output.url()`. The raw REST response carries the
   *              same shape. We parse all three. */
  output?: string | string[] | { url?: string } | null;
  error?: string | null;
  metrics?: { predict_time?: number };
}

/** Extract the result URL across Replicate's three known output shapes. */
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run a full lipsync via Replicate: POST → poll until terminal → return output URL.
 *
 * Returns { videoUrl: null, error } on failure. NEVER throws on transient
 * network errors during polling — the caller handles refund + status row.
 */
export async function generateLipsync(
  opts: ReplicateLipsyncOptions,
): Promise<ReplicateLipsyncResult> {
  const apiKey = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_TOKEN;
  const base = process.env.REPLICATE_API_BASE || DEFAULT_BASE;
  const model: LipsyncModel = opts.model ?? "lipsync-2";
  const provider = "replicate";

  if (!apiKey) {
    return { videoUrl: null, provider, model, error: "REPLICATE_API_KEY is not configured" };
  }

  const startTime = Date.now();
  const pollMaxMs = opts.pollMaxMs ?? DEFAULT_POLL_MAX_MS;

  // ── 1. Create the prediction ─────────────────────────────────────
  let predictionId: string;
  try {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "Replicate lipsync aborted before submission" };
    }

    const createRes = await fetch(`${base}/models/${MODEL_OWNER}/${model}/predictions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          // sync/lipsync-2 model accepts `video` + `audio` URLs. Both must
          // be publicly fetchable. Supabase signed URLs (default 7-day TTL
          // on the video bucket) work fine.
          video: opts.videoUrl,
          audio: opts.audioUrl,
        },
      }),
      signal: opts.signal,
    });

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      const err = `Replicate submit ${createRes.status}: ${errText.substring(0, 200)}`;
      console.warn(`[ReplicateLipsync] ${err}`);
      return { videoUrl: null, provider, model, error: err };
    }

    const created = (await createRes.json()) as PredictionResponse;
    if (!created?.id) {
      return { videoUrl: null, provider, model, error: "Replicate response missing prediction id" };
    }
    predictionId = created.id;
    console.log(`[ReplicateLipsync] Submitted prediction ${predictionId} (model=${MODEL_OWNER}/${model})`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { videoUrl: null, provider, model, error: "Replicate lipsync aborted by hard-timeout signal" };
    }
    return {
      videoUrl: null,
      provider,
      model,
      error: `Replicate submit threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── 2. Poll until terminal or timeout ─────────────────────────────
  const pollDeadline = Date.now() + pollMaxMs;
  let lastStatus: PredictionStatus | "" = "";

  while (Date.now() < pollDeadline) {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "Replicate poll aborted by hard-timeout signal" };
    }

    try {
      const pollRes = await fetch(`${base}/predictions/${predictionId}`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: opts.signal,
      });
      if (!pollRes.ok) {
        // 4xx non-429 is permanent (auth, bad id). Keep polling on 5xx / 429.
        if (pollRes.status >= 400 && pollRes.status < 500 && pollRes.status !== 429) {
          const errText = await pollRes.text().catch(() => "");
          return {
            videoUrl: null, provider, model,
            error: `Replicate poll ${pollRes.status}: ${errText.substring(0, 200)}`,
          };
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const body = (await pollRes.json()) as PredictionResponse;
      if (body.status !== lastStatus) {
        console.log(`[ReplicateLipsync] Prediction ${predictionId} status=${body.status}`);
        lastStatus = body.status;
      }

      if (body.status === "succeeded") {
        const outputUrl = extractOutputUrl(body.output);
        if (!outputUrl) {
          return { videoUrl: null, provider, model, error: "Replicate succeeded but no output URL" };
        }
        const durationSeconds = body.metrics?.predict_time;
        writeApiLog({
          userId: opts.userId ?? null,
          generationId: opts.generationId ?? null,
          provider, model: `${MODEL_OWNER}/${model}`,
          status: "success",
          totalDurationMs: Date.now() - startTime,
          cost: lipsyncCostUsd(model, durationSeconds ?? 0),
          error: undefined,
        }).catch((e) => console.warn(`[ReplicateLipsync] api log failed: ${(e as Error).message}`));

        return { videoUrl: outputUrl, durationSeconds, provider, model };
      }

      if (body.status === "failed" || body.status === "canceled") {
        return {
          videoUrl: null, provider, model,
          error: `Replicate ${body.status}: ${body.error ?? "no reason given"}`,
        };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { videoUrl: null, provider, model, error: "Replicate poll aborted by hard-timeout signal" };
      }
      // Network blip during poll — keep going.
      console.warn(`[ReplicateLipsync] Poll exception (will retry): ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Cancel the prediction on Replicate's side so we don't keep paying for
  // compute on a result we'll never use. Fire-and-forget — if cancel
  // fails for any reason, the worst case is Replicate finishes the
  // prediction and bills us; the existing retry on the user's next click
  // would still produce a new prediction anyway.
  cancelPrediction(base, apiKey, predictionId).catch((e) =>
    console.warn(`[ReplicateLipsync] cancel failed for ${predictionId}: ${(e as Error).message}`),
  );

  writeApiLog({
    userId: opts.userId ?? null,
    generationId: opts.generationId ?? null,
    provider, model: `${MODEL_OWNER}/${model}`,
    status: "error",
    totalDurationMs: Date.now() - startTime,
    cost: 0,
    error: `Replicate prediction poll timeout after ${Math.round(pollMaxMs / 1000)}s`,
  }).catch((e) => console.warn(`[ReplicateLipsync] api log failed: ${(e as Error).message}`));

  return {
    videoUrl: null, provider, model,
    error: `Replicate prediction ${predictionId} did not complete within ${Math.round(pollMaxMs / 1000)}s — try again, Replicate's queue may be deep right now`,
  };
}

/** POST /v1/predictions/<id>/cancel — best-effort abort.
 *  Replicate stops billing for cancelled predictions as soon as the worker
 *  acknowledges. Used when our poll budget expires so we don't keep paying
 *  for a result we'll never read. */
async function cancelPrediction(base: string, apiKey: string, id: string): Promise<void> {
  const res = await fetch(`${base}/predictions/${id}/cancel`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!res.ok && res.status !== 404) {
    // 404 means it already terminated — safe to ignore. Anything else is
    // unexpected; log so we notice if Replicate changes the endpoint shape.
    console.warn(`[ReplicateLipsync] cancel returned ${res.status} for ${id}`);
  } else {
    console.log(`[ReplicateLipsync] Cancelled prediction ${id}`);
  }
}

/** USD cost for a completed lipsync. Replicate bills by predict_time
 *  (compute seconds), which closely tracks output duration for sync/lipsync-2. */
function lipsyncCostUsd(model: LipsyncModel, outputSeconds: number): number {
  const perSec = model === "lipsync-2-pro" ? 0.15 : 0.06;
  return Math.max(0, outputSeconds * perSec);
}
