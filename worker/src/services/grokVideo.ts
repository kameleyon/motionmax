/**
 * Grok Imagine Video via Hypereal API (grok-video-i2v).
 *
 * - No sound
 * - 10-second duration (configurable up to 15s)
 * - 1080P resolution
 * - Respect project aspect ratio (landscape → 16:9, portrait → 9:16)
 *
 * Requires env var: HYPEREAL_API_KEY
 */

import { generateGrokVideo as hyperealGrokVideo } from "./hypereal.js";

// ── Types ──────────────────────────────────────────────────────────

type GrokAspectRatio = "16:9" | "9:16";

export interface GrokVideoInput {
  prompt: string;
  imageUrl?: string;       // optional first-frame image (REQUIRED for Hypereal)
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
    case "square":    return "16:9"; // Default to 16:9 for square
    case "landscape":
    default:          return "16:9";
  }
}

// ── Generator ──────────────────────────────────────────────────────

export async function generateGrokVideo(
  input: GrokVideoInput,
): Promise<GrokVideoResult> {
  // Hypereal API key from env
  const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  if (!hyperealApiKey) {
    return { url: null, provider: "Grok Video (Hypereal)", error: "HYPEREAL_API_KEY not set" };
  }

  // Hypereal Grok requires an image URL (image-to-video only)
  if (!input.imageUrl) {
    return {
      url: null,
      provider: "Grok Video (Hypereal)",
      error: "Hypereal Grok Video I2V requires an image URL"
    };
  }

  const aspectRatio = mapFormatToAspectRatio(input.format);
  const duration = 10; // Can be 10 or 15 seconds
  const resolution = "1080P"; // 720P or 1080P

  console.log(`[GrokVideo] Starting Hypereal Grok — aspect_ratio=${aspectRatio}, duration=${duration}s, resolution=${resolution}`);

  try {
    const outputUrl = await hyperealGrokVideo(
      input.imageUrl,
      input.prompt,
      hyperealApiKey,
      aspectRatio,
      duration,
      resolution
    );

    if (!outputUrl) {
      return { url: null, provider: "Grok Video (Hypereal)", error: "No output URL returned" };
    }

    console.log(`[GrokVideo] ✅ Complete — ${String(outputUrl).substring(0, 80)}…`);
    return { url: outputUrl, provider: "Grok Video (Hypereal)" };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[GrokVideo] ❌ Failed — ${msg}`);
    return { url: null, provider: "Grok Video (Hypereal)", error: msg };
  }
}
