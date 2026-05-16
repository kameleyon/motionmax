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
import { acquireOpenRouter, releaseOpenRouter } from "./openrouter.js";

const OR_BASE = "https://openrouter.ai/api/v1";
const OR_SUBMIT_URL = `${OR_BASE}/videos`;
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_MAX_MS = 4 * 60 * 1000;

export type OpenRouterVideoModel =
  | "bytedance/seedance-1-5-pro"
  | "kwaivgi/kling-video-o1";

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
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Extract the final video URL from one of several observed response
 *  shapes. OpenRouter proxies multiple upstream providers and each
 *  nests the URL differently. */
function extractVideoUrl(data: unknown): string | null {
  const d = data as Record<string, unknown> | null;
  if (!d) return null;
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

  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
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
        if (typeof pj?.cost === "number") cost = pj.cost as number;
        if (status === "completed" || status === "succeeded") {
          const videoUrl = extractVideoUrl(pj);
          if (!videoUrl) {
            return { videoUrl: null, provider, model, cost,
              error: `OpenRouter completed but URL not found in response` };
          }
          console.log(`[OpenRouterVideo:${model}] Completed in ${Math.round((Date.now() - startTime) / 1000)}s`);
          return { videoUrl, durationSeconds: duration, provider, model, cost };
        }
        if (status === "failed" || status === "error" || (pj as { error?: unknown }).error) {
          const errMsg = (pj as { error?: { message?: string } }).error?.message
            ?? (pj as { failure_reason?: string }).failure_reason
            ?? `OpenRouter status=${status}`;
          return { videoUrl: null, provider, model, cost,
            error: `OpenRouter video ${model} failed: ${errMsg}` };
        }
        // still pending — keep polling
      } catch (_err) {
        // network blip — keep polling
      }
    }

    return { videoUrl: null, provider, model, cost,
      error: `OpenRouter video poll timeout after ${Math.round(pollMaxMs / 1000)}s` };
  } finally {
    releaseOpenRouter();
  }
}
