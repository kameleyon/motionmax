/**
 * Replicate-hosted Seedance 2.0 (full, not Fast) — direct from ByteDance.
 *
 * Why the full model (not Fast):
 *   - Fast doesn't expose `last_image` for start→end frame transitions.
 *     motionmax needs that for cinematic scene continuity. Migrated
 *     2026-05-14 from `bytedance/seedance-2.0-fast` to `bytedance/seedance-2.0`
 *     after the Fast path logged the "endImageUrl ignored" warning on
 *     every scene.
 *   - Slight cost bump ($0.07/sec → $0.08/sec at 480p), still ~71%
 *     cheaper than Hypereal's 281 cr/10s billing.
 *
 * Model: bytedance/seedance-2.0
 *   - I2V (image-to-video) with optional last_image (first→last frame)
 *   - Duration 5–15s (motionmax always passes 5–10s per scene)
 *   - Resolution 480p (default — 71% cheaper than Hypereal) / 720p / 1080p
 *   - Aspect ratios: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, 9:21, adaptive
 *
 * Replicate prediction lifecycle:
 *   1. POST /v1/models/bytedance/seedance-2.0/predictions →
 *      `{ id, status: "starting", urls: { get, cancel } }`
 *   2. GET urls.get (polled every 3s) until status terminates
 *   3. On `succeeded`, `output` is either a URL string or { url: "..." }
 *      (Replicate File-typed output)
 *
 * Auth: `REPLICATE_API_KEY` (fallback `REPLICATE_API_TOKEN`).
 */

import { writeApiLog } from "../lib/logger.js";

const REPLICATE_BASE = "https://api.replicate.com/v1";
const REPLICATE_SUBMIT_URL = `${REPLICATE_BASE}/models/bytedance/seedance-2.0/predictions`;
const POLL_INTERVAL_MS = 3_000;
// 15 min is generous for the P99 tail. Replicate's queue can sit for
// several minutes during US business hours; once running, a 10s clip
// renders in 1–3 min.
const DEFAULT_POLL_MAX_MS = 15 * 60 * 1000;
const MODEL_ID = "bytedance/seedance-2.0";

export type ReplicateSeedanceResolution = "480p" | "720p";
export type ReplicateSeedanceAspectRatio =
  | "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9" | "9:21" | "adaptive";

export interface ReplicateSeedanceOptions {
  imageUrl: string;                            // first frame (publicly fetchable URI)
  prompt: string;
  duration?: number;                           // clamped to [5, 15]; default 5
  aspectRatio?: ReplicateSeedanceAspectRatio;  // default "16:9"
  resolution?: ReplicateSeedanceResolution;    // default "480p" (75% cheaper than 720p)
  /** Last-frame for start→end transitions. Passed to Replicate as
   *  `last_image`. Supported by the full `bytedance/seedance-2.0` model
   *  (Fast variant did NOT — that's why we migrated up). */
  endImageUrl?: string;
  seed?: number;
  userId?: string | null;
  generationId?: string | null;
  signal?: AbortSignal;
  pollMaxMs?: number;
  /** Mirrors the Hypereal callback: invoked synchronously between
   *  submit and poll with the provider jobId + poll URL. Handlers use
   *  this to persist a resume checkpoint so a worker restart can
   *  re-poll the SAME prediction instead of submitting a duplicate
   *  (re-charging Replicate). */
  onSubmitted?: (info: { providerJobId: string; pollUrl: string | null; model: string }) => Promise<void>;
}

export interface ReplicateSeedanceResult {
  videoUrl: string | null;
  durationSeconds?: number;
  provider: "replicate";
  model: "bytedance/seedance-2.0";
  error?: string;
}

type ReplicateStatus =
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

interface ReplicatePrediction {
  id: string;
  status: ReplicateStatus;
  urls?: {
    get?: string;
    cancel?: string;
  };
  // output can be a string (URL), an object with `url`, or an array
  // — handle all shapes via extractOutputUrl below.
  output?: unknown;
  error?: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run Seedance 2.0 Fast I2V on Replicate: POST → poll → return URL.
 *
 * Returns { videoUrl: null, error } on failure. NEVER throws on transient
 * poll errors — the caller (handleCinematicVideo) classifies the result
 * and falls back to the Hypereal chain when error is set.
 */
export async function generateReplicateSeedance(
  opts: ReplicateSeedanceOptions,
): Promise<ReplicateSeedanceResult> {
  const apiKey = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_TOKEN;
  const provider = "replicate" as const;
  const model = MODEL_ID as "bytedance/seedance-2.0";

  if (!apiKey) {
    return {
      videoUrl: null, provider, model,
      error: "REPLICATE_API_KEY (or REPLICATE_API_TOKEN) is not configured",
    };
  }

  const resolution: ReplicateSeedanceResolution = opts.resolution ?? "480p";
  const aspectRatio: ReplicateSeedanceAspectRatio = opts.aspectRatio ?? "16:9";
  const requestedDuration = opts.duration ?? 5;
  const clampedDuration = Math.min(15, Math.max(5, Math.round(requestedDuration)));
  if (clampedDuration !== requestedDuration) {
    console.warn(
      `[ReplicateSeedance] duration ${requestedDuration}s out of [5,15] — clamped to ${clampedDuration}s`,
    );
  }

  const input: Record<string, unknown> = {
    prompt: opts.prompt,
    image: opts.imageUrl,
    duration: clampedDuration,
    resolution,
    aspect_ratio: aspectRatio,
  };
  // Seedance 2.0 (full) accepts `last_image` for start→end frame
  // interpolation. We pass it when provided so cinematic scene
  // transitions land cleanly. If Replicate ever rejects this field
  // (model schema change), the API surfaces a 400 with the exact
  // field name and the handler falls through to Hypereal Seedance.
  if (opts.endImageUrl) {
    input.last_image = opts.endImageUrl;
    console.log(`[ReplicateSeedance] LAST IMAGE: ${opts.endImageUrl.substring(0, 80)}...`);
  }
  if (typeof opts.seed === "number" && Number.isFinite(opts.seed)) {
    input.seed = opts.seed;
  }

  const startTime = Date.now();
  const pollMaxMs = opts.pollMaxMs ?? DEFAULT_POLL_MAX_MS;

  console.log(
    `[ReplicateSeedance] Starting Seedance 2.0 — ${clampedDuration}s, ${resolution}, ${aspectRatio}` +
    `${opts.endImageUrl ? " (start→end)" : ""}`,
  );
  console.log(`[ReplicateSeedance] IMAGE: ${opts.imageUrl.substring(0, 80)}...`);

  // ── 1. Submit the prediction ───────────────────────────────────────
  let predictionId: string;
  let pollUrl: string | null = null;
  let cancelUrl: string | null = null;
  try {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "Replicate Seedance aborted before submission" };
    }

    const submitRes = await fetch(REPLICATE_SUBMIT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input }),
      signal: opts.signal,
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => "");
      const err = `Replicate Seedance submit ${submitRes.status}: ${errText.substring(0, 200)}`;
      console.warn(`[ReplicateSeedance] ${err}`);
      writeApiLog({
        userId: opts.userId ?? null,
        generationId: opts.generationId ?? null,
        provider, model,
        status: "error",
        totalDurationMs: Date.now() - startTime,
        cost: 0,
        error: err.slice(0, 500),
      }).catch((e) => console.warn(`[ReplicateSeedance] api log failed: ${(e as Error).message}`));
      return { videoUrl: null, provider, model, error: err };
    }

    const created = (await submitRes.json()) as ReplicatePrediction;
    if (!created?.id) {
      return { videoUrl: null, provider, model, error: "Replicate Seedance response missing prediction id" };
    }
    predictionId = created.id;
    pollUrl = created.urls?.get ?? `${REPLICATE_BASE}/predictions/${predictionId}`;
    cancelUrl = created.urls?.cancel ?? null;
    console.log(`[ReplicateSeedance] Submitted prediction ${predictionId} (status=${created.status})`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { videoUrl: null, provider, model, error: "Replicate Seedance aborted by hard-timeout signal" };
    }
    const msg = `Replicate Seedance submit threw: ${err instanceof Error ? err.message : String(err)}`;
    writeApiLog({
      userId: opts.userId ?? null,
      generationId: opts.generationId ?? null,
      provider, model,
      status: "error",
      totalDurationMs: Date.now() - startTime,
      cost: 0,
      error: msg.slice(0, 500),
    }).catch((e) => console.warn(`[ReplicateSeedance] api log failed: ${(e as Error).message}`));
    return { videoUrl: null, provider, model, error: msg };
  }

  // Persist resume checkpoint immediately — if the worker dies during
  // polling, the next worker reads this and re-polls the SAME prediction
  // instead of resubmitting (which would double-charge Replicate).
  if (opts.onSubmitted) {
    try {
      await opts.onSubmitted({ providerJobId: predictionId, pollUrl, model });
    } catch (cbErr) {
      console.warn(
        `[ReplicateSeedance] onSubmitted callback failed (non-fatal): ${(cbErr as Error).message}`,
      );
    }
  }

  // ── 2. Poll until terminal or timeout ───────────────────────────────
  const pollDeadline = Date.now() + pollMaxMs;
  let lastStatus: ReplicateStatus | "" = "";

  while (Date.now() < pollDeadline) {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "Replicate Seedance poll aborted by hard-timeout signal" };
    }

    try {
      const pollRes = await fetch(pollUrl, {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: opts.signal,
      });
      if (!pollRes.ok) {
        // 4xx (except 429) is permanent — bail with the body so the caller
        // can classify. 5xx + 429 are transient; warn and retry.
        if (pollRes.status >= 400 && pollRes.status < 500 && pollRes.status !== 429) {
          const errText = await pollRes.text().catch(() => "");
          const err = `Replicate Seedance poll ${pollRes.status}: ${errText.substring(0, 200)}`;
          writeApiLog({
            userId: opts.userId ?? null,
            generationId: opts.generationId ?? null,
            provider, model,
            status: "error",
            totalDurationMs: Date.now() - startTime,
            cost: 0,
            error: err.slice(0, 500),
          }).catch((e) => console.warn(`[ReplicateSeedance] api log failed: ${(e as Error).message}`));
          return { videoUrl: null, provider, model, error: err };
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const body = (await pollRes.json()) as ReplicatePrediction;
      if (body.status !== lastStatus) {
        console.log(`[ReplicateSeedance] prediction ${predictionId} status=${body.status}`);
        lastStatus = body.status;
      }

      if (body.status === "succeeded") {
        const url = extractOutputUrl(body.output);
        if (!url) {
          return {
            videoUrl: null, provider, model,
            error: `Replicate Seedance succeeded but no output URL — ${JSON.stringify(body.output).slice(0, 200)}`,
          };
        }
        const cost = replicateSeedanceCostUsd(resolution, clampedDuration);
        writeApiLog({
          userId: opts.userId ?? null,
          generationId: opts.generationId ?? null,
          provider, model,
          status: "success",
          totalDurationMs: Date.now() - startTime,
          cost,
          error: undefined,
        }).catch((e) => console.warn(`[ReplicateSeedance] api log failed: ${(e as Error).message}`));

        return { videoUrl: url, durationSeconds: clampedDuration, provider, model };
      }

      if (body.status === "failed" || body.status === "canceled") {
        const err = `Replicate Seedance ${body.status}: ${body.error ?? "no reason given"}`;
        writeApiLog({
          userId: opts.userId ?? null,
          generationId: opts.generationId ?? null,
          provider, model,
          status: "error",
          totalDurationMs: Date.now() - startTime,
          cost: 0,
          error: err.slice(0, 500),
        }).catch((e) => console.warn(`[ReplicateSeedance] api log failed: ${(e as Error).message}`));
        return { videoUrl: null, provider, model, error: err };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { videoUrl: null, provider, model, error: "Replicate Seedance poll aborted by hard-timeout signal" };
      }
      console.warn(
        `[ReplicateSeedance] Poll exception (will retry): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // ── 3. Timeout — best-effort cancel so Replicate stops billing ─────
  if (cancelUrl) {
    cancelReplicatePrediction(cancelUrl, apiKey).catch((e) =>
      console.warn(`[ReplicateSeedance] cancel failed for ${predictionId}: ${(e as Error).message}`),
    );
  }

  writeApiLog({
    userId: opts.userId ?? null,
    generationId: opts.generationId ?? null,
    provider, model,
    status: "error",
    totalDurationMs: Date.now() - startTime,
    cost: 0,
    error: `Replicate Seedance poll timeout after ${Math.round(pollMaxMs / 1000)}s`,
  }).catch((e) => console.warn(`[ReplicateSeedance] api log failed: ${(e as Error).message}`));

  return {
    videoUrl: null, provider, model,
    error: `Replicate Seedance prediction ${predictionId} did not complete within ${Math.round(pollMaxMs / 1000)}s`,
  };
}

/**
 * Replicate output is one of:
 *   - "https://...mp4"          (string URL, most common)
 *   - { url: "https://...mp4" } (FileOutput object)
 *   - ["https://...mp4", ...]   (rare for single-clip models, but handled)
 */
function extractOutputUrl(output: unknown): string | null {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0) {
    const first = output[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "url" in first && typeof (first as { url: unknown }).url === "string") {
      return (first as { url: string }).url;
    }
    return null;
  }
  if (typeof output === "object" && output !== null && "url" in output) {
    const u = (output as { url: unknown }).url;
    if (typeof u === "string") return u;
  }
  return null;
}

async function cancelReplicatePrediction(cancelUrl: string, apiKey: string): Promise<void> {
  const res = await fetch(cancelUrl, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`[ReplicateSeedance] cancel returned ${res.status}`);
  } else {
    console.log(`[ReplicateSeedance] Cancelled prediction (${cancelUrl})`);
  }
}

/** USD cost — Replicate bills Seedance 2.0 Fast by output second.
 *  - 480p I2V: $0.07/sec
 *  - 720p I2V: $0.15/sec
 *  A 10s 480p clip = $0.70; a 10s 720p clip = $1.50.
 */
function replicateSeedanceCostUsd(
  resolution: ReplicateSeedanceResolution,
  outputSeconds: number,
): number {
  const perSec = resolution === "720p" ? 0.15 : 0.07;
  return Math.max(0, outputSeconds * perSec);
}
