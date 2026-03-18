/**
 * Image generation service for the worker.
 * Tries Hypereal (gemini-3-1-flash-t2i) first with 4 retries,
 * then falls back to Replicate nano-banana-2.
 *
 * IMPORTANT: Hypereal CDN URLs (r2.dev) have hotlink protection —
 * browsers sending a Referer from motionmax.io get blocked.
 * We ALWAYS download image bytes and re-upload to Supabase Storage
 * so the frontend loads from our own domain (no restriction).
 */

import { supabase } from "../lib/supabase.js";
import { v4 as uuidv4 } from "uuid";

// ── Constants ──────────────────────────────────────────────────────

const HYPEREAL_API_URL = "https://hypereal.tech/api/v1/images/generate";
const HYPEREAL_MODEL = "gemini-3-1-flash-t2i";
const HYPEREAL_RETRIES = 4;

const REPLICATE_API_URL = "https://api.replicate.com/v1/models/google/nano-banana-2/predictions";
const REPLICATE_POLL_URL = "https://api.replicate.com/v1/predictions";
const REPLICATE_RETRIES = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Aspect ratio ──────────────────────────────────────────────────

function toAspectRatio(format: string): string {
  if (format === "portrait") return "9:16";
  if (format === "square") return "1:1";
  return "16:9";
}

// ── Supabase Storage upload ────────────────────────────────────────

async function uploadToStorage(bytes: Uint8Array, projectId: string): Promise<string> {
  const fileName = `${projectId}/${uuidv4()}.png`;
  const { error } = await supabase.storage
    .from("scene-images")
    .upload(fileName, bytes, { contentType: "image/png", upsert: true });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from("scene-images").getPublicUrl(fileName);
  return data.publicUrl;
}

// ── Hypereal ───────────────────────────────────────────────────────

/** Generate from Hypereal, download bytes, return raw bytes (not URL). */
async function tryHypereal(
  prompt: string,
  apiKey: string,
  format: string,
): Promise<Uint8Array | null> {
  const aspectRatio = toAspectRatio(format);

  for (let attempt = 1; attempt <= HYPEREAL_RETRIES; attempt++) {
    try {
      const res = await fetch(HYPEREAL_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, model: HYPEREAL_MODEL, aspect_ratio: aspectRatio }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.warn(`[ImageGen] Hypereal attempt ${attempt} failed (${res.status}): ${err.substring(0, 200)}`);
        if (attempt < HYPEREAL_RETRIES) await sleep(1500 * attempt);
        continue;
      }

      const data = await res.json() as any;
      const hyperealUrl = data?.data?.[0]?.url;
      if (!hyperealUrl) {
        console.warn(`[ImageGen] Hypereal attempt ${attempt}: no URL in response`);
        if (attempt < HYPEREAL_RETRIES) await sleep(1500 * attempt);
        continue;
      }

      // Download bytes (no Referer header sent — no hotlink block)
      const imgRes = await fetch(hyperealUrl);
      if (!imgRes.ok) {
        console.warn(`[ImageGen] Hypereal download failed (${imgRes.status}) on attempt ${attempt}`);
        if (attempt < HYPEREAL_RETRIES) await sleep(1500 * attempt);
        continue;
      }

      const bytes = new Uint8Array(await imgRes.arrayBuffer());
      console.log(`[ImageGen] Hypereal ✅ attempt ${attempt} — ${bytes.length} bytes`);
      return bytes;
    } catch (err) {
      console.warn(`[ImageGen] Hypereal attempt ${attempt} threw: ${err}`);
      if (attempt < HYPEREAL_RETRIES) await sleep(1500 * attempt);
    }
  }

  return null;
}

/** TRUE image edit via Replicate google/nano-banana-2 with image_input.
 *  Downloads the edited image bytes — caller uploads to Supabase. */
async function tryReplicateEdit(
  editInstruction: string,
  sourceImageUrl: string,
  apiKey: string,
  format: string,
  styleDesc?: string,
): Promise<Uint8Array | null> {
  const MODEL = "google/nano-banana-2";
  const aspectRatio = toAspectRatio(format);

  const fullPrompt = `Edit this image with the following modification: ${editInstruction}

IMPORTANT REQUIREMENTS:
- Preserve the overall composition, lighting, and style of the original image
- Apply ONLY the requested modification while keeping everything else intact
- Maintain the same artistic style and color palette${styleDesc ? `\n\nSTYLE CONTEXT: ${styleDesc}` : ""}`;

  try {
    console.log(`[ImageGen] Nano Banana 2 edit: ${editInstruction.substring(0, 80)}`);
    console.log(`[ImageGen] Source: ${sourceImageUrl.substring(0, 80)}...`);

    const createRes = await fetch(`https://api.replicate.com/v1/models/${MODEL}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        input: {
          prompt: fullPrompt,
          image_input: [sourceImageUrl],
          aspect_ratio: aspectRatio,
          output_format: "png",
          resolution: "1K",
        },
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      console.warn(`[ImageGen] Nano Banana 2 edit failed (${createRes.status}): ${errText.substring(0, 200)}`);
      return null;
    }

    let prediction = await createRes.json() as any;
    console.log(`[ImageGen] Nano Banana 2 prediction: ${prediction.id} status=${prediction.status}`);

    // Poll if not yet finished (Prefer: wait may time out)
    let polls = 0;
    while (prediction.status !== "succeeded" && prediction.status !== "failed" && polls < 30) {
      await sleep(2000);
      polls++;
      const pollRes = await fetch(`${REPLICATE_POLL_URL}/${prediction.id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (pollRes.ok) prediction = await pollRes.json();
    }

    if (prediction.status === "failed") {
      console.warn(`[ImageGen] Nano Banana 2 edit failed: ${prediction.error}`);
      return null;
    }

    const first = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    const resultUrl = typeof first === "string"
      ? first
      : first && typeof first === "object" && typeof (first as any).url === "string"
        ? (first as any).url
        : null;

    if (!resultUrl) {
      console.warn("[ImageGen] Nano Banana 2 edit: no image URL in response");
      return null;
    }

    const imgRes = await fetch(resultUrl);
    if (!imgRes.ok) {
      console.warn(`[ImageGen] Nano Banana 2 edit download failed: ${imgRes.status}`);
      return null;
    }

    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    console.log(`[ImageGen] Nano Banana 2 edit ✅ — ${bytes.length} bytes`);
    return bytes;
  } catch (err) {
    console.warn(`[ImageGen] Nano Banana 2 edit threw: ${err}`);
    return null;
  }
}

// ── Replicate ──────────────────────────────────────────────────────

async function tryReplicate(
  prompt: string,
  apiKey: string,
  format: string,
  projectId: string,
): Promise<string | null> {
  const aspectRatio = toAspectRatio(format);

  for (let attempt = 1; attempt <= REPLICATE_RETRIES; attempt++) {
    try {
      const createRes = await fetch(REPLICATE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({ input: { prompt, aspect_ratio: aspectRatio, output_format: "webp" } }),
      });

      if (!createRes.ok) {
        console.warn(`[ImageGen] Replicate attempt ${attempt} failed: ${createRes.status}`);
        if (attempt < REPLICATE_RETRIES) await sleep(2000 * attempt);
        continue;
      }

      const prediction = await createRes.json() as any;

      if (prediction.status === "succeeded" && prediction.output?.[0]) {
        const imgRes = await fetch(prediction.output[0]);
        if (imgRes.ok) {
          const bytes = new Uint8Array(await imgRes.arrayBuffer());
          return await uploadToStorage(bytes, projectId);
        }
      }

      if (prediction.id && prediction.status !== "failed") {
        const url = await pollReplicate(prediction.id, apiKey, projectId);
        if (url) return url;
      }

      if (attempt < REPLICATE_RETRIES) await sleep(2000 * attempt);
    } catch (err) {
      console.warn(`[ImageGen] Replicate attempt ${attempt} threw: ${err}`);
      if (attempt < REPLICATE_RETRIES) await sleep(2000 * attempt);
    }
  }

  return null;
}

async function pollReplicate(
  predictionId: string,
  apiKey: string,
  projectId: string,
  maxAttempts = 30,
): Promise<string | null> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(3000);
    const res = await fetch(`${REPLICATE_POLL_URL}/${predictionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) continue;
    const data = await res.json() as any;
    if (data.status === "succeeded" && data.output?.[0]) {
      const imgRes = await fetch(data.output[0]);
      if (imgRes.ok) {
        const bytes = new Uint8Array(await imgRes.arrayBuffer());
        return await uploadToStorage(bytes, projectId);
      }
    }
    if (data.status === "failed") return null;
  }
  return null;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Generate one image: Hypereal first, Replicate fallback.
 * Always re-uploads to Supabase Storage and returns a public Supabase URL.
 */
export async function generateImage(
  prompt: string,
  hyperealApiKey: string,
  replicateApiKey: string,
  format: string,
  projectId: string,
): Promise<string> {
  // Primary: Hypereal → download bytes → upload to Supabase
  if (hyperealApiKey) {
    const bytes = await tryHypereal(prompt, hyperealApiKey, format);
    if (bytes) {
      const url = await uploadToStorage(bytes, projectId);
      return url;
    }
    console.warn("[ImageGen] Hypereal exhausted — falling back to Replicate");
  }

  // Fallback: Replicate (already uploads to Supabase internally)
  if (replicateApiKey) {
    const url = await tryReplicate(prompt, replicateApiKey, format, projectId);
    if (url) return url;
  }

  throw new Error("Image generation failed: both Hypereal and Replicate exhausted");
}

/**
 * Edit one image IN-PLACE using the existing image as input.
 *
 * Uses Replicate google/nano-banana-2 with `image_input: [sourceUrl]`
 * so the model receives the actual pixels and applies the edit — NOT
 * a blind regeneration.
 *
 * Always re-uploads to Supabase Storage and returns a public Supabase URL.
 */
export async function editImage(
  editInstruction: string,
  imageUrl: string,
  hyperealApiKey: string,
  projectId: string,
  originalPrompt?: string,
  replicateApiKey?: string,
  format?: string,
  styleDesc?: string,
): Promise<string> {
  // ── Primary: Replicate nano-banana-2 with image_input (TRUE edit) ──
  if (replicateApiKey) {
    const bytes = await tryReplicateEdit(
      editInstruction, imageUrl, replicateApiKey, format || "landscape", styleDesc,
    );
    if (bytes) {
      const url = await uploadToStorage(bytes, projectId);
      return url;
    }
    console.warn("[ImageGen] Replicate nano-banana-2 edit failed");
  }

  throw new Error("Image edit failed: REPLICATE_API_KEY not configured or edit failed");
}
