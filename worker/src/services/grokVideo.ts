/**
 * Grok Imagine Video via Replicate API (xai/grok-imagine-video).
 *
 * - No sound
 * - 5-second duration
 * - Respect project aspect ratio (landscape → 16:9, portrait → 9:16, square → 1:1)
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
  const apiToken = process.env.REPLICATE_API_TOKEN;
  if (!apiToken) {
    return { url: null, provider: "Grok Video", error: "REPLICATE_API_TOKEN not configured" };
  }

  const replicate = new Replicate({ auth: apiToken });
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

    // Replicate returns a FileOutput with a .url() method
    const outputUrl = typeof output === "string"
      ? output
      : typeof (output as any)?.url === "function"
        ? (output as any).url()
        : String(output);

    if (!outputUrl || outputUrl === "null" || outputUrl === "undefined") {
      return { url: null, provider: "Grok Video", error: "No output URL returned" };
    }

    console.log(`[GrokVideo] ✅ Complete — ${outputUrl.substring(0, 80)}…`);
    return { url: outputUrl, provider: "Grok Video" };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[GrokVideo] ❌ Failed — ${msg}`);
    return { url: null, provider: "Grok Video", error: msg };
  }
}
