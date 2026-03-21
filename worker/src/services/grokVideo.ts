/**
 * Grok Imagine Video via Replicate API (xai/grok-imagine-video).
 *
 * - No sound
 * - 5-second duration
 * - Respect project aspect ratio (landscape → 16:9, portrait → 9:16, square → 1:1)
 *
 * Requires env var: REPLICATE_API_TOKEN
 */

import Replicate from "replicate";

// ── Types ──────────────────────────────────────────────────────────

type GrokAspectRatio = "16:9" | "9:16" | "4:3" | "3:4" | "1:1" | "21:9";

export interface GrokVideoInput {
  prompt: string;
  imageUrl?: string;       // optional first-frame image
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
    case "square":    return "1:1";
    case "landscape":
    default:          return "16:9";
  }
}

// ── Generator ──────────────────────────────────────────────────────

export async function generateGrokVideo(
  input: GrokVideoInput,
): Promise<GrokVideoResult> {
  // Replicate client auto-reads REPLICATE_API_TOKEN from env
  if (!process.env.REPLICATE_API_TOKEN) {
    return { url: null, provider: "Grok Video", error: "REPLICATE_API_TOKEN not set" };
  }

  const replicate = new Replicate();
  const aspectRatio = mapFormatToAspectRatio(input.format);

  const replicateInput: Record<string, unknown> = {
    prompt: input.prompt,
    duration: 5,
    aspect_ratio: aspectRatio,
  };

  // If an image URL is provided, use it as the first frame (image-to-video)
  if (input.imageUrl) {
    replicateInput.image = input.imageUrl;
  }

  console.log(`[GrokVideo] Starting — aspect_ratio=${aspectRatio}, duration=5s, hasImage=${!!input.imageUrl}`);

  try {
    const output = await replicate.run("xai/grok-imagine-video", { input: replicateInput });

    // Replicate FileOutput: coerce to string via .url() or String()
    let outputUrl = "";
    if (output && typeof (output as any).url === "function") {
      const u = (output as any).url();
      outputUrl = typeof u === "string" ? u : String(u ?? "");
    } else if (typeof output === "string") {
      outputUrl = output;
    } else if (output && typeof (output as any).href === "string") {
      // URL object
      outputUrl = (output as any).href;
    } else if (output) {
      outputUrl = String(output);
    }

    if (!outputUrl || outputUrl === "null" || outputUrl === "undefined") {
      return { url: null, provider: "Grok Video", error: "No output URL returned" };
    }

    console.log(`[GrokVideo] ✅ Complete — ${String(outputUrl).substring(0, 80)}…`);
    return { url: outputUrl, provider: "Grok Video" };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[GrokVideo] ❌ Failed — ${msg}`);
    return { url: null, provider: "Grok Video", error: msg };
  }
}
