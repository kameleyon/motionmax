/**
 * Image generation service for the worker.
 * Tries Hypereal (gemini-3-1-flash-t2i) first with 4 retries,
 * then falls back to Replicate nano-banana-2.
 * Returns a public URL (Hypereal returns URL directly;
 * Replicate returns bytes that we upload to Supabase Storage).
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

// ── Aspect ratio mapper ────────────────────────────────────────────

function toAspectRatio(format: string): string {
  if (format === "portrait") return "9:16";
  if (format === "square") return "1:1";
  return "16:9";
}

// ── Hypereal ───────────────────────────────────────────────────────

async function tryHypereal(
  prompt: string,
  apiKey: string,
  format: string,
): Promise<string | null> {
  const aspectRatio = toAspectRatio(format);

  for (let attempt = 1; attempt <= HYPEREAL_RETRIES; attempt++) {
    try {
      const res = await fetch(HYPEREAL_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt, model: HYPEREAL_MODEL, format: aspectRatio }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.warn(`[ImageGen] Hypereal attempt ${attempt} failed (${res.status}): ${err.substring(0, 200)}`);
        if (attempt < HYPEREAL_RETRIES) await sleep(1500 * attempt);
        continue;
      }

      const data = await res.json() as any;
      const url = data?.data?.[0]?.url;
      if (!url) {
        console.warn(`[ImageGen] Hypereal attempt ${attempt}: no URL in response`);
        if (attempt < HYPEREAL_RETRIES) await sleep(1500 * attempt);
        continue;
      }

      console.log(`[ImageGen] Hypereal success on attempt ${attempt}`);
      return url as string;
    } catch (err) {
      console.warn(`[ImageGen] Hypereal attempt ${attempt} threw: ${err}`);
      if (attempt < HYPEREAL_RETRIES) await sleep(1500 * attempt);
    }
  }

  return null;
}

// ── Replicate ──────────────────────────────────────────────────────

async function uploadBytesToStorage(
  bytes: Uint8Array,
  projectId: string,
): Promise<string> {
  const fileName = `images/${projectId}/${uuidv4()}.webp`;
  const { error } = await supabase.storage
    .from("generation-assets")
    .upload(fileName, bytes, { contentType: "image/webp", upsert: true });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from("generation-assets").getPublicUrl(fileName);
  return data.publicUrl;
}

async function tryReplicate(
  prompt: string,
  apiKey: string,
  format: string,
  projectId: string,
): Promise<string | null> {
  const aspectRatio = toAspectRatio(format);

  for (let attempt = 1; attempt <= REPLICATE_RETRIES; attempt++) {
    try {
      // Create prediction
      const createRes = await fetch(REPLICATE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({
          input: { prompt, aspect_ratio: aspectRatio, output_format: "webp" },
        }),
      });

      if (!createRes.ok) {
        console.warn(`[ImageGen] Replicate create attempt ${attempt} failed: ${createRes.status}`);
        if (attempt < REPLICATE_RETRIES) await sleep(2000 * attempt);
        continue;
      }

      const prediction = await createRes.json() as any;

      // If already completed (Prefer: wait)
      if (prediction.status === "succeeded" && prediction.output?.[0]) {
        const imageUrl = prediction.output[0];
        // Download and re-upload to our own storage
        const imgRes = await fetch(imageUrl);
        if (imgRes.ok) {
          const bytes = new Uint8Array(await imgRes.arrayBuffer());
          return await uploadBytesToStorage(bytes, projectId);
        }
      }

      // Poll if still processing
      if (prediction.id && prediction.status !== "failed") {
        const finalUrl = await pollReplicate(prediction.id, apiKey, projectId);
        if (finalUrl) return finalUrl;
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
      const imageUrl = data.output[0];
      const imgRes = await fetch(imageUrl);
      if (imgRes.ok) {
        const bytes = new Uint8Array(await imgRes.arrayBuffer());
        return await uploadBytesToStorage(bytes, projectId);
      }
    }
    if (data.status === "failed") return null;
  }
  return null;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Generate one image: tries Hypereal first, falls back to Replicate.
 * Returns a public URL or throws if both fail.
 */
export async function generateImage(
  prompt: string,
  hyperealApiKey: string,
  replicateApiKey: string,
  format: string,
  projectId: string,
): Promise<string> {
  // Primary: Hypereal
  if (hyperealApiKey) {
    const url = await tryHypereal(prompt, hyperealApiKey, format);
    if (url) return url;
    console.warn("[ImageGen] Hypereal exhausted all retries — falling back to Replicate");
  }

  // Fallback: Replicate
  if (replicateApiKey) {
    const url = await tryReplicate(prompt, replicateApiKey, format, projectId);
    if (url) return url;
  }

  throw new Error("Image generation failed: both Hypereal and Replicate exhausted");
}
