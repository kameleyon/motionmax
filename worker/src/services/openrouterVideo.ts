/**
 * OpenRouter video generation — used as rungs 1 and 3 of the cinematic
 * video provider chain in handleCinematicVideo.ts.
 *
 * Rung 1: bytedance/seedance-1-5-pro @ 480p — cheapest 10s I2V on
 *         OpenRouter that supports first+last frame.
 * Rung 3: kwaivgi/kling-video-o1 @ 480p — sits between AtlasCloud and
 *         Hypereal Kling V3 Pro.
 *
 * Same POST /api/v1/videos endpoint for both; only the `model` string
 * differs. Returns { videoUrl: null, error } on any failure — never
 * throws on poll errors. Matches the failure-handling contract of
 * atlasCloudSeedance.ts so the handler chain treats all rungs
 * uniformly.
 *
 * Auth: OPENROUTER_API_KEY (env). Reuses the existing module-wide
 * concurrency limiter from ./openrouter.ts so video and LLM calls
 * share the per-key rate-limit budget.
 */

import { writeApiLog } from "../lib/logger.js";
import { openRouterVideoCostUsd } from "../lib/providerRates.js";
import { acquireOpenRouter, releaseOpenRouter } from "./openrouter.js";

const OR_BASE = "https://openrouter.ai/api/v1";
const OR_SUBMIT_URL = `${OR_BASE}/videos`;
const POLL_INTERVAL_MS = 5_000;
// 4 min wasn't enough under OpenRouter queue depth (Seedance 1.5 Pro
// scenes were timing out before the model even started generating).
// 8 min absorbs the queue without blowing past CINEMATIC_VIDEO_TIMEOUT_MS
// (45 min) — even if all 6 fallback rungs walked their full poll cap,
// the worst-case is ~48 min vs the 45-min job timeout, and in practice
// the chain short-circuits on the first rung that returns a real
// success or a hard failure (only timeouts walk the cap).
const DEFAULT_POLL_MAX_MS = 8 * 60 * 1000;

export type OpenRouterVideoModel =
  | "bytedance/seedance-1-5-pro"
  | "bytedance/seedance-2.0-fast"
  | "kwaivgi/kling-video-o1";

/** Per-model prompt length caps (characters). Providers reject over-long
 *  prompts on SUBMIT — Kling O1 returns `400 prompt: size must be between
 *  0 and 2500`, which was terminal-failing the last rung of the cinematic
 *  chain on length alone (a 3154-char cinematic prompt never even reached
 *  the model). Seedance accepts longer prompts, so it keeps a generous
 *  ceiling. Any model not listed falls back to the strictest cap. */
const MODEL_PROMPT_LIMIT: Record<OpenRouterVideoModel, number> = {
  "bytedance/seedance-1-5-pro": 5000,
  "bytedance/seedance-2.0-fast": 5000,
  "kwaivgi/kling-video-o1": 2500,
};
const STRICTEST_PROMPT_LIMIT = 2500;

/** Clamp `prompt` to `max` characters on a word boundary so a rung is
 *  never rejected purely on length. Trims back to the last space when
 *  that space is reasonably close to the cap (avoids lopping off most of
 *  the prompt when the tail happens to be one very long token). */
function clampPrompt(prompt: string, max: number): string {
  if (prompt.length <= max) return prompt;
  const slice = prompt.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trim();
}

export interface OpenRouterVideoOptions {
  model: OpenRouterVideoModel;
  imageUrl: string;
  endImageUrl?: string;
  prompt: string;
  duration?: number;                      // default 10
  aspectRatio?: "16:9" | "9:16";          // default "16:9" — no 1:1
  resolution?: "480p" | "720p" | "1080p"; // default "480p"
  userId?: string | null;
  generationId?: string | null;
  jobId?: string | null;
  signal?: AbortSignal;
  pollMaxMs?: number;                     // default 4 min
  onSubmitted?: (info: {
    providerJobId: string;
    pollUrl: string | null;
    model: string;
  }) => Promise<void>;
}

export interface OpenRouterVideoResult {
  videoUrl: string | null;
  durationSeconds?: number;
  provider: "openrouter";
  model: OpenRouterVideoModel;
  cost?: number;
  /** OpenRouter video URLs are "unsigned" — they require an
   *  Authorization: Bearer <OPENROUTER_API_KEY> header to download.
   *  The handler passes this through to uploadVideoToStorage so the
   *  initial download from OpenRouter succeeds. Supabase Storage hosts
   *  the re-uploaded copy with no auth needed. */
  downloadAuthHeader?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Extract the final video URL from one of several observed response
 *  shapes. OpenRouter's actual completed-prediction response (verified
 *  2026-05-17 against a real prediction) is:
 *    { id, status: "completed", unsigned_urls: ["https://openrouter.ai/.../content?index=0"], usage: { cost } }
 *  The unsigned_urls[0] path is checked FIRST; the other candidates are
 *  kept as defensive fallbacks in case the upstream proxy shape varies
 *  by model. The "unsigned" URL requires Bearer auth to download (see
 *  downloadAuthHeader on the Result). */
function extractVideoUrl(data: unknown): string | null {
  const d = data as Record<string, unknown> | null;
  if (!d) return null;
  const unsignedUrls = (d as { unsigned_urls?: unknown }).unsigned_urls;
  if (Array.isArray(unsignedUrls) && typeof unsignedUrls[0] === "string" && unsignedUrls[0].startsWith("http")) {
    return unsignedUrls[0];
  }
  const candidates: unknown[] = [
    (d as { output?: { video?: { url?: unknown } } }).output?.video?.url,
    (d as { video_url?: unknown }).video_url,
    (d as { url?: unknown }).url,
    (d as { output?: unknown }).output,
    (d as { data?: { output?: unknown } }).data?.output,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("http")) return c;
  }
  return null;
}

export async function generateOpenRouterVideo(
  opts: OpenRouterVideoOptions,
): Promise<OpenRouterVideoResult> {
  const provider = "openrouter" as const;
  const model = opts.model;
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();

  if (!apiKey) {
    return { videoUrl: null, provider, model, error: "OPENROUTER_API_KEY is not configured" };
  }

  const resolution = opts.resolution ?? "480p";
  const aspectRatio = opts.aspectRatio ?? "16:9";
  const duration = opts.duration ?? 10;
  const pollMaxMs = opts.pollMaxMs ?? DEFAULT_POLL_MAX_MS;

  const promptCap = MODEL_PROMPT_LIMIT[model] ?? STRICTEST_PROMPT_LIMIT;
  const prompt = clampPrompt(opts.prompt, promptCap);
  if (prompt.length < opts.prompt.length) {
    console.warn(
      `[OpenRouterVideo:${model}] prompt clamped ${opts.prompt.length}→${prompt.length} chars (model cap ${promptCap})`,
    );
  }

  const body: Record<string, unknown> = {
    model,
    prompt,
    frame_images: [
      { type: "image_url", frame_type: "first_frame", image_url: { url: opts.imageUrl } },
      ...(opts.endImageUrl
        ? [{ type: "image_url", frame_type: "last_frame", image_url: { url: opts.endImageUrl } }]
        : []),
    ],
    duration,
    aspect_ratio: aspectRatio,
    resolution,
  };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://motionmax.app",
    "X-Title": "motionmax video",
  };

  const startTime = Date.now();

  await acquireOpenRouter();
  try {
    // ── 1. Submit ─────────────────────────────────────────────────────
    if (opts.signal?.aborted) {
      return { videoUrl: null, provider, model, error: "OpenRouter video aborted before submission" };
    }

    let submitRes: Response;
    let createdRaw: unknown;
    try {
      submitRes = await fetch(OR_SUBMIT_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      const submitTextOrNull = submitRes.ok ? null : await submitRes.text().catch(() => "");
      if (!submitRes.ok) {
        const err = `OpenRouter video submit ${submitRes.status}: ${(submitTextOrNull ?? "").slice(0, 200)}`;
        console.warn(`[OpenRouterVideo:${model}] ${err}`);
        writeApiLog({
          userId: opts.userId ?? null, generationId: opts.generationId ?? null, jobId: opts.jobId ?? null,
          provider, model, status: "error",
          totalDurationMs: Date.now() - startTime,
          cost: 0,
          error: err.slice(0, 500),
        }).catch((e) => console.warn(`[OpenRouterVideo:${model}] api log failed: ${(e as Error).message}`));
        return { videoUrl: null, provider, model, error: err };
      }

      createdRaw = await submitRes.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { videoUrl: null, provider, model, error: `OpenRouter video submit failed: ${msg}` };
    }

    const created = createdRaw as { id?: string; polling_url?: string };
    if (!created?.id) {
      return { videoUrl: null, provider, model, error: "OpenRouter response missing id" };
    }
    const providerJobId = created.id;
    const pollUrl = created.polling_url ?? `${OR_BASE}/videos/${providerJobId}`;
    console.log(`[OpenRouterVideo:${model}] Submitted ${providerJobId}`);

    if (opts.onSubmitted) {
      try {
        await opts.onSubmitted({ providerJobId, pollUrl, model });
      } catch (err) {
        console.warn(
          `[OpenRouterVideo:${model}] onSubmitted callback failed (non-fatal): ${(err as Error).message}`,
        );
      }
    }

    // ── 2. Poll ───────────────────────────────────────────────────────
    let cost: number | undefined;
    while (Date.now() - startTime < pollMaxMs) {
      if (opts.signal?.aborted) {
        return { videoUrl: null, provider, model, error: "OpenRouter video aborted during poll" };
      }
      await sleep(POLL_INTERVAL_MS);
      try {
        const pr = await fetch(pollUrl, { headers, signal: opts.signal });
        if (!pr.ok) continue;
        const pj = await pr.json() as Record<string, unknown>;
        const status = (pj?.status ?? (pj?.data as { status?: string } | undefined)?.status) as string | undefined;
        // Cost lives at `usage.cost` per OpenRouter's actual response
        // (verified 2026-05-17). Older `cost` at the top level is kept
        // as a defensive fallback in case the shape changes.
        const usageCost = (pj?.usage as { cost?: unknown } | undefined)?.cost;
        if (typeof usageCost === "number") cost = usageCost;
        else if (typeof pj?.cost === "number") cost = pj.cost as number;
        if (status === "completed" || status === "succeeded") {
          const videoUrl = extractVideoUrl(pj);
          if (!videoUrl) {
            const err = `OpenRouter completed but URL not found in response`;
            writeApiLog({
              userId: opts.userId ?? null, generationId: opts.generationId ?? null, jobId: opts.jobId ?? null,
              provider, model, status: "error",
              totalDurationMs: Date.now() - startTime,
              cost: 0,
              error: err.slice(0, 500),
            }).catch((e) => console.warn(`[OpenRouterVideo:${model}] api log failed: ${(e as Error).message}`));
            return { videoUrl: null, provider, model, cost, error: err };
          }
          const elapsed = Date.now() - startTime;
          console.log(`[OpenRouterVideo:${model}] Completed in ${Math.round(elapsed / 1000)}s`);
          const finalCost = Number.isFinite(cost) && (cost as number) >= 0
            ? (cost as number)
            : openRouterVideoCostUsd(model, resolution, duration);
          writeApiLog({
            userId: opts.userId ?? null, generationId: opts.generationId ?? null, jobId: opts.jobId ?? null,
            provider, model, status: "success",
            totalDurationMs: elapsed,
            cost: finalCost,
          }).catch((e) => console.warn(`[OpenRouterVideo:${model}] api log failed: ${(e as Error).message}`));
          return {
            videoUrl, durationSeconds: duration, provider, model, cost: finalCost,
            downloadAuthHeader: `Bearer ${apiKey}`,
          };
        }
        if (status === "failed" || status === "error" || (pj as { error?: unknown }).error) {
          // Pull the upstream reason from every shape we've observed:
          //   { error: { message: "..." } }              ← OpenAI-style
          //   { error: "string"          }               ← simple
          //   { failure_reason: "..." }                  ← provider-passthrough
          //   { error: { code, type, ... } }             ← structured
          // If none match, fall through to a JSON dump of the whole `error`
          // field so we can see WHY a provider rejected — otherwise the
          // log just says "OpenRouter status=failed" and debugging is blind.
          const errField = (pj as { error?: unknown }).error;
          const errMsg =
            (errField && typeof errField === "object" && typeof (errField as { message?: unknown }).message === "string"
              ? (errField as { message: string }).message
              : null)
            ?? (typeof errField === "string" ? errField : null)
            ?? (pj as { failure_reason?: unknown }).failure_reason as string | undefined
            ?? (errField ? `error=${JSON.stringify(errField).slice(0, 300)}` : null)
            ?? `status=${status}`;
          const fullErr = `OpenRouter video ${model} failed: ${errMsg}`;
          writeApiLog({
            userId: opts.userId ?? null, generationId: opts.generationId ?? null, jobId: opts.jobId ?? null,
            provider, model, status: "error",
            totalDurationMs: Date.now() - startTime,
            // OpenRouter only bills on successful generation; a cost captured
            // from an interim "processing" poll frame is misleading on failure.
            cost: 0,
            error: fullErr.slice(0, 500),
          }).catch((e) => console.warn(`[OpenRouterVideo:${model}] api log failed: ${(e as Error).message}`));
          return { videoUrl: null, provider, model, cost, error: fullErr };
        }
        // still pending — keep polling
      } catch (_err) {
        // network blip — keep polling
      }
    }

    const timeoutErr = `OpenRouter video poll timeout after ${Math.round(pollMaxMs / 1000)}s`;
    writeApiLog({
      userId: opts.userId ?? null, generationId: opts.generationId ?? null, jobId: opts.jobId ?? null,
      provider, model, status: "error",
      totalDurationMs: Date.now() - startTime,
      cost: 0,
      error: timeoutErr,
    }).catch((e) => console.warn(`[OpenRouterVideo:${model}] api log failed: ${(e as Error).message}`));
    return { videoUrl: null, provider, model, cost, error: timeoutErr };
  } finally {
    releaseOpenRouter();
  }
}
