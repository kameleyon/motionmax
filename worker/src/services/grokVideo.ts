/**
 * Grok Imagine Video orchestrator.
 *
 * Primary:  Hypereal API (grok-video-i2v) — 1080P, 10s
 * Fallback: Replicate API (xai/grok-imagine-video) — 720p, 10s
 *
 * Requires env vars: HYPEREAL_API_KEY, REPLICATE_API_KEY
 */

import { generateGrokVideo as hyperealGrokVideo } from "./hypereal.js";

// ── Types ──────────────────────────────────────────────────────────

type GrokAspectRatio = "16:9" | "9:16";

export interface GrokVideoInput {
  prompt: string;
  imageUrl?: string;
  /** End-state image for morphing transitions (passed as end_image to API) */
  endImageUrl?: string;
  format: string;          // "landscape" | "portrait" | "square"
}

export interface GrokVideoResult {
  url: string | null;
  provider: string;
  error?: string;
}

// ── Format mapping ─────────────────────────────────────────────────

function mapFormatToAspectRatio(format: string): GrokAspectRatio {
  switch (format?.toLowerCase()) {
    case "portrait":  return "9:16";
    case "square":    return "16:9";
    case "landscape":
    default:          return "16:9";
  }
}

// ── Orchestrator ───────────────────────────────────────────────────

export async function generateGrokVideo(
  input: GrokVideoInput,
): Promise<GrokVideoResult> {
  const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
  const aspectRatio = mapFormatToAspectRatio(input.format);

  const hasEndImage = !!input.endImageUrl;
  if (hasEndImage) {
    console.log(`[GrokVideo] Transition mode: start + end image provided`);
  }

  // ── 1. Try Hypereal Grok (primary — 1080P, 10s) ──────────────
  if (hyperealApiKey && input.imageUrl) {
    console.log(`[GrokVideo] Trying Hypereal Grok — ${aspectRatio}, 10s, 1080P`);
    try {
      const outputUrl = await hyperealGrokVideo(
        input.imageUrl,
        input.prompt,
        hyperealApiKey,
        aspectRatio,
        10,
        "1080P",
        input.endImageUrl
      );
      if (outputUrl) {
        console.log(`[GrokVideo] ✅ Hypereal Grok succeeded`);
        return { url: outputUrl, provider: "Hypereal Grok" };
      }
    } catch (err: any) {
      console.warn(`[GrokVideo] ❌ Hypereal Grok failed: ${err?.message || err}`);
    }
  }

  // ── 2. Fallback: Replicate Grok (720p, 10s) ──────────────────
  if (replicateApiKey) {
    console.log(`[GrokVideo] Trying Replicate Grok fallback — ${aspectRatio}, 10s, 720p`);
    try {
      const url = await replicateGrokVideo(
        input.prompt,
        input.imageUrl || null,
        replicateApiKey,
        aspectRatio,
        10,
        input.endImageUrl || null
      );
      if (url) {
        console.log(`[GrokVideo] ✅ Replicate Grok succeeded`);
        return { url, provider: "Replicate Grok" };
      }
    } catch (err: any) {
      console.warn(`[GrokVideo] ❌ Replicate Grok failed: ${err?.message || err}`);
    }
  }

  return {
    url: null,
    provider: "Grok Video",
    error: "Both Hypereal and Replicate Grok exhausted"
  };
}

// ── Replicate Grok Imagine Video ───────────────────────────────────

const REPLICATE_API = "https://api.replicate.com/v1/models/xai/grok-imagine-video/predictions";
const REPLICATE_POLL = "https://api.replicate.com/v1/predictions";

async function replicateGrokVideo(
  prompt: string,
  imageUrl: string | null,
  apiKey: string,
  aspectRatio: string,
  duration: number,
  endImageUrl: string | null = null,
): Promise<string | null> {
  const input: Record<string, unknown> = {
    prompt,
    duration,
    aspect_ratio: aspectRatio,
    resolution: "720p",
  };

  if (imageUrl) {
    input.image = imageUrl;
  }

  // End image for morphing transitions (frame interpolation)
  if (endImageUrl) {
    input.end_image = endImageUrl;
  }

  // Create prediction
  const createRes = await fetch(REPLICATE_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => "");
    throw new Error(`Replicate create failed: ${createRes.status} — ${errText.substring(0, 200)}`);
  }

  const prediction = await createRes.json() as any;
  const predId = prediction.id;

  if (!predId) {
    throw new Error(`No prediction ID from Replicate: ${JSON.stringify(prediction)}`);
  }

  console.log(`[GrokVideo] Replicate prediction created: ${predId}`);

  // Poll for completion
  return pollReplicatePrediction(predId, apiKey);
}

async function pollReplicatePrediction(
  predId: string,
  apiKey: string,
): Promise<string | null> {
  const maxAttempts = 60;    // 60 × 10s = 10 min
  const pollMs = 10_000;     // 10s between polls

  for (let i = 1; i <= maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollMs));

    if (i <= 2 || i % 5 === 0) {
      console.log(`[GrokVideo] Replicate poll ${predId} (${i}/${maxAttempts})...`);
    }

    const res = await fetch(`${REPLICATE_POLL}/${predId}`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`[GrokVideo] Replicate 429 — backing off`);
        await new Promise(r => setTimeout(r, 30_000));
        continue;
      }
      console.warn(`[GrokVideo] Replicate poll HTTP ${res.status}`);
      continue;
    }

    const data = await res.json() as any;

    if (data.status === "succeeded") {
      // output can be a string URL or FileOutput
      const output = data.output;
      if (typeof output === "string") return output;
      if (output?.url) return output.url;
      if (Array.isArray(output) && output[0]) {
        return typeof output[0] === "string" ? output[0] : output[0]?.url;
      }
      throw new Error(`Replicate succeeded but unexpected output: ${JSON.stringify(data.output)}`);
    }

    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(`Replicate Grok ${data.status}: ${data.error || "unknown"}`);
    }

    // "starting" or "processing" — continue
  }

  throw new Error(`Replicate Grok timed out after ${maxAttempts} polls`);
}
