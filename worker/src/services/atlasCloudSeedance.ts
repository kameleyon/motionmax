/**
 * AtlasCloud-hosted Seedance 2.0 — primary cinematic video provider.
 *
 * Why AtlasCloud over Replicate:
 *   - ~2× faster: ~1m 40s vs Replicate's ~3m 35s for the same 5s clip
 *   - Same ByteDance Seedance 2.0 model under the hood (so frame quality
 *     is equivalent)
 *   - Honors BOTH `image` (first frame) AND `last_image` (last frame)
 *     for true start→end frame I2V (verified 2026-05-14 with the same
 *     tarot-card → motivational-checklist probe we used for Replicate)
 *   - Token-billed: 48,400 tokens for a 5s 640x640 clip — confirm rate
 *     in their dashboard
 *
 * Field-name footgun: AtlasCloud uses `last_image` (NOT
 * `last_frame_image` like Replicate). Same model, different schemas.
 *
 * Lifecycle:
 *   1. POST /api/v1/model/generateVideo →
 *      `{ code:200, data: { id, status: "processing", urls: { get } } }`
 *   2. GET data.urls.get (poll every ~5s) until status terminates
 *   3. On `completed`, `data.outputs` is an array of URLs
 *      (Aliyun OSS short-lived; rehost to Supabase storage immediately)
 *
 * Auth: `ATLASCLOUD_API_KEY` with `Bearer ` prefix (the spec says raw
 * apiKey but the server requires Bearer empirically).
 */

import { writeApiLog } from "../lib/logger.js";

const ATLAS_BASE = "https://api.atlascloud.ai";
const ATLAS_SUBMIT_URL = `${ATLAS_BASE}/api/v1/model/generateVideo`;
const POLL_INTERVAL_MS = 5_000;
// 10 min is generous — observed P50 ~1m 40s, P99 expected under 5 min.
const DEFAULT_POLL_MAX_MS = 10 * 60 * 1000;
const MODEL_ID = "bytedance/seedance-2.0/image-to-video";

export type AtlasCloudSeedanceResolution = "480p" | "720p" | "1080p";
export type AtlasCloudSeedanceAspectRatio =
  | "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9" | "9:21";

export interface AtlasCloudSeedanceOptions {
  imageUrl: string;                                // first frame (publicly fetchable URI)
  prompt: string;
  duration?: number;                               // clamped to [4, 15]; default 5
  aspectRatio?: AtlasCloudSeedanceAspectRatio;     // default "16:9"
  resolution?: AtlasCloudSeedanceResolution;       // default "480p"
  /** Last-frame for start→end transitions. AtlasCloud's field name is
   *  `last_image` (NOT `last_frame_image` — that's Replicate's name). */
  endImageUrl?: string;
  seed?: number;
  userId?: string | null;
  generationId?: string | null;
  signal?: AbortSignal;
  pollMaxMs?: number;
  /** Mirrors the other Seedance providers' callback — persist a
   *  resume checkpoint after submit so a worker restart re-polls the
   *  same prediction instead of double-charging AtlasCloud. */
  onSubmitted?: (info: { providerJobId: string; pollUrl: string | null; model: string }) => Promise<void>;
}

export interface AtlasCloudSeedanceResult {
  videoUrl: string | null;
  durationSeconds?: number;
  provider: "atlascloud";
  model: "bytedance/seedance-2.0/image-to-video";
  /** completion_tokens from AtlasCloud — used by writeApiLog cost math. */
  completionTokens?: number;
  error?: string;
}

interface AtlasCloudSubmitResponse {
  code?: number;
  message?: string;
  data?: {
    id: string;
    model?: string;
    status?: string;
    urls?: { get?: string };
    outputs?: string[] | null;
    has_nsfw_contents?: boolean[] | null;
    error?: string;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run Seedance 2.0 I2V on AtlasCloud: POST → poll → return URL.
 *
 * Returns { videoUrl: null, error } on failure (NEVER throws on poll
 * errors — caller classifies the result and falls back to the next
 * provider in the chain when error is set).
 */
export async function generateAtlasCloudSeedance(
  opts: AtlasCloudSeedanceOptions,
): Promise<AtlasCloudSeedanceResult> {
  const apiKey = (process.env.ATLASCLOUD_API_KEY || "").trim();
  const provider = "atlascloud" as const;
  const model = MODEL_ID as "bytedance/seedance-2.0/image-to-video";

  if (!apiKey) {
    return {
      videoUrl: null, provider, model,
      error: "ATLASCLOUD_API_KEY is not configured",
    };
  }

  const resolution: AtlasCloudSeedanceResolution = opts.resolution ?? "480p";
  const aspectRatio: AtlasCloudSeedanceAspectRatio = opts.aspectRatio ?? "16:9";
  const requestedDuration = opts.duration ?? 5;
  const clampedDuration = Math.min(15, Math.max(4, Math.round(requestedDuration)));
  if (clampedDuration !== requestedDuration) {
    console.warn(
      `[AtlasCloudSeedance] duration ${requestedDuration}s out of [4,15] — clamped to ${clampedDuration}s`,
    );
  }

  const input: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    image: opts.imageUrl,
    duration: clampedDuration,
    resolution,
    aspect_ratio: aspectRatio,
    // motionmax mux's its own voice track during export — never let
    // the model generate audio. Same setting as Replicate / Hypereal.
    generate_audio: false,
  };
  if (opts.endImageUrl) {
    input.last_image = opts.endImageUrl;
    console.log(`[AtlasCloudSeedance] LAST IMAGE: ${opts.endImageUrl.substring(0, 80)}...`);
  }
  if (typeof opts.seed === "number" && Number.isFinite(opts.seed)) {
    input.seed = opts.seed;
  }

  const startTime = Date.now();
  const pollMaxMs = opts.pollMaxMs ?? DEFAULT_POLL_MAX_MS;

  console.log(
    `[AtlasCloudSeedance] Starting Seedance 2.0 — ${clampedDuration}s, ${resolution}, ${aspectRatio}` +
    `${opts.endImageUrl ? " (start→end)" : ""}`,
  );
  console.log(`[AtlasCloudSeedance] IMAGE: ${opts.imageUrl.substring(0, 80)}...`);

  // ── 1. Submit the prediction ───────────────────────────────────────
  let predictionId: string;
  let pollUrl: string | null = null;
  try {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "AtlasCloud Seedance aborted before submission" };
    }

    const submitRes = await fetch(ATLAS_SUBMIT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: opts.signal,
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text().catch(() => "");
      const err = `AtlasCloud Seedance submit ${submitRes.status}: ${errText.substring(0, 200)}`;
      console.warn(`[AtlasCloudSeedance] ${err}`);
      writeApiLog({
        userId: opts.userId ?? null, generationId: opts.generationId ?? null,
        provider, model,
        status: "error",
        totalDurationMs: Date.now() - startTime,
        cost: 0,
        error: err.slice(0, 500),
      }).catch((e) => console.warn(`[AtlasCloudSeedance] api log failed: ${(e as Error).message}`));
      return { videoUrl: null, provider, model, error: err };
    }

    const created = (await submitRes.json()) as AtlasCloudSubmitResponse;
    if (!created?.data?.id) {
      return { videoUrl: null, provider, model, error: "AtlasCloud Seedance response missing data.id" };
    }
    predictionId = created.data.id;
    pollUrl = created.data.urls?.get ?? `${ATLAS_BASE}/api/v1/model/prediction/${predictionId}`;
    console.log(`[AtlasCloudSeedance] Submitted prediction ${predictionId} (status=${created.data.status ?? "?"})`);

    if (opts.onSubmitted) {
      try { await opts.onSubmitted({ providerJobId: predictionId, pollUrl, model }); }
      catch (err) { console.warn(`[AtlasCloudSeedance] onSubmitted callback failed (non-fatal): ${(err as Error).message}`); }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { videoUrl: null, provider, model, error: `AtlasCloud Seedance submit failed: ${msg}` };
  }

  // ── 2. Poll until terminal ─────────────────────────────────────────
  let finalData: AtlasCloudSubmitResponse["data"] | null = null;
  while (Date.now() - startTime < pollMaxMs) {
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "AtlasCloud Seedance aborted during poll" };
    }
    await sleep(POLL_INTERVAL_MS);
    try {
      const pr = await fetch(pollUrl!, {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: opts.signal,
      });
      if (!pr.ok) {
        // Transient — try again
        continue;
      }
      const pj = (await pr.json()) as AtlasCloudSubmitResponse;
      const status = pj?.data?.status;
      if (status === "succeeded" || status === "completed") {
        finalData = pj.data ?? null;
        break;
      }
      if (status === "failed" || status === "error" || pj?.data?.error) {
        const errMsg = pj?.data?.error || `AtlasCloud Seedance prediction failed: status=${status}`;
        writeApiLog({
          userId: opts.userId ?? null, generationId: opts.generationId ?? null,
          provider, model,
          status: "error",
          totalDurationMs: Date.now() - startTime,
          cost: 0,
          error: errMsg.slice(0, 500),
        }).catch((e) => console.warn(`[AtlasCloudSeedance] api log failed: ${(e as Error).message}`));
        return { videoUrl: null, provider, model, error: errMsg };
      }
      // status === "processing" / "starting" — keep polling
    } catch (err) {
      // Network blip — log and continue. Total poll budget bounds the loop.
      console.warn(`[AtlasCloudSeedance] poll iteration error: ${(err as Error).message}`);
    }
  }

  if (!finalData) {
    return {
      videoUrl: null, provider, model,
      error: `AtlasCloud Seedance poll timed out after ${Math.round(pollMaxMs / 60000)} min`,
    };
  }

  const outputs = finalData.outputs ?? [];
  const videoUrl = Array.isArray(outputs) && outputs.length > 0 ? outputs[0] : null;
  if (!videoUrl) {
    return { videoUrl: null, provider, model, error: "AtlasCloud Seedance succeeded but no output URL" };
  }

  // NSFW post-flag — AtlasCloud generates first then flags. If any
  // output is flagged, return as moderation error so the handler can
  // route to held-frame instead of using a flagged frame.
  const nsfwArr = finalData.has_nsfw_contents ?? [];
  if (Array.isArray(nsfwArr) && nsfwArr.some(Boolean)) {
    return {
      videoUrl: null, provider, model,
      error: "AtlasCloud Seedance: output flagged as NSFW (has_nsfw_contents)",
    };
  }

  const totalDurationMs = Date.now() - startTime;
  console.log(`[AtlasCloudSeedance] ✓ ${MODEL_ID} ${predictionId} succeeded in ${Math.round(totalDurationMs / 1000)}s`);

  writeApiLog({
    userId: opts.userId ?? null, generationId: opts.generationId ?? null,
    provider, model,
    status: "success",
    totalDurationMs,
    cost: 0, // token-based; rate-card mapping TBD in providerRates.ts
    error: undefined,
  }).catch((e) => console.warn(`[AtlasCloudSeedance] api log failed: ${(e as Error).message}`));

  return {
    videoUrl, provider, model,
    durationSeconds: clampedDuration,
    completionTokens: finalData.completion_tokens,
  };
}
