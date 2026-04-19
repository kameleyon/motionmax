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
import { writeApiLog } from "../lib/logger.js";
import { v4 as uuidv4 } from "uuid";

// ── Constants ──────────────────────────────────────────────────────

const HYPEREAL_API_URL = "https://api.hypereal.cloud/v1/images/generate";
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

  // Log masked key on first attempt for debugging
  const keyLen = apiKey.length;
  const maskedKey = keyLen === 0 ? "(EMPTY)" : keyLen <= 12
    ? `${apiKey.substring(0, 3)}…${apiKey.substring(keyLen - 3)} (${keyLen}ch)`
    : `${apiKey.substring(0, 6)}…${apiKey.substring(keyLen - 4)} (${keyLen}ch)`;
  console.log(`[ImageGen] Hypereal key in use: ${maskedKey}`);

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
        // Do not retry on 4xx client errors — they won't succeed on retry
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          console.warn(`[ImageGen] Hypereal giving up on ${res.status} (client error, non-retriable)`);
          return null;
        }
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
        if (imgRes.status >= 400 && imgRes.status < 500 && imgRes.status !== 429) {
          console.warn(`[ImageGen] Hypereal download giving up on ${imgRes.status} (non-retriable)`);
          return null;
        }
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

// ── Replicate ──────────────────────────────────────────────────────

async function tryReplicate(
  prompt: string,
  apiKey: string,
  format: string,
  projectId: string,
  imageInputs?: string[],
): Promise<string | null> {
  const aspectRatio = toAspectRatio(format);

  for (let attempt = 1; attempt <= REPLICATE_RETRIES; attempt++) {
    try {
      const input: Record<string, unknown> = { prompt, aspect_ratio: aspectRatio };
      // Pass source images for edits (Replicate nano-banana-2 image_input)
      if (imageInputs && imageInputs.length > 0) {
        input.image_input = imageInputs;
      } else {
        input.output_format = "png"; // nano-banana-2 only accepts "jpg" or "png"
      }
      const createRes = await fetch(REPLICATE_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({ input }),
      });

      if (!createRes.ok) {
        const errBody = await createRes.text().catch(() => "");
        console.warn(`[ImageGen] Replicate attempt ${attempt} failed (${createRes.status}): ${errBody.substring(0, 300)}`);
        if (createRes.status >= 400 && createRes.status < 500 && createRes.status !== 429) {
          console.warn(`[ImageGen] Replicate giving up on ${createRes.status} (client error, non-retriable)`);
          return null;
        }
        if (attempt < REPLICATE_RETRIES) await sleep(2000 * attempt);
        continue;
      }

      const prediction = await createRes.json() as any;

      // nano-banana-2 returns output as a single URL string OR an array
      const outputUrl = typeof prediction.output === "string"
        ? prediction.output
        : Array.isArray(prediction.output) ? prediction.output[0] : null;

      if (prediction.status === "succeeded" && outputUrl) {
        const imgRes = await fetch(outputUrl);
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
    const pollOutputUrl = typeof data.output === "string"
      ? data.output
      : Array.isArray(data.output) ? data.output[0] : null;
    if (data.status === "succeeded" && pollOutputUrl) {
      const imgRes = await fetch(pollOutputUrl);
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
  const startTime = Date.now();

  // Primary: Hypereal → download bytes → upload to Supabase
  if (hyperealApiKey) {
    const bytes = await tryHypereal(prompt, hyperealApiKey, format);
    if (bytes) {
      const url = await uploadToStorage(bytes, projectId);
      writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: "gemini-3-1-flash-t2i", status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[ImageGen] background log failed:', (err as Error).message); });
      return url;
    }
    console.warn("[ImageGen] Hypereal exhausted — falling back to Replicate");
  }

  // Fallback: Replicate (already uploads to Supabase internally)
  if (replicateApiKey) {
    const url = await tryReplicate(prompt, replicateApiKey, format, projectId);
    if (url) {
      writeApiLog({ userId: undefined, generationId: undefined, provider: "replicate", model: "nano-banana-2", status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[ImageGen] background log failed:', (err as Error).message); });
      return url;
    }
  }

  const err = new Error("Image generation failed: both Hypereal and Replicate exhausted");
  writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: "gemini-3-1-flash-t2i", status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch((err) => { console.warn('[ImageGen] background log failed:', (err as Error).message); });
  throw err;
}

/**
 * Edit one image using Replicate nano-banana-2 with image_input.
 * Dedicated edit function — separate from tryReplicate to ensure
 * image_input is always passed correctly for edits.
 * Hypereal as fallback (text-only re-generation from modified prompt).
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
  const editPrompt = `${editInstruction}`;

  console.log(`[ImageGen] Edit: "${editInstruction.substring(0, 80)}" | source: ${imageUrl.substring(0, 60)}...`);

  // Primary: Replicate nano-banana-2 with image_input
  if (replicateApiKey) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const body = {
          input: {
            prompt: editPrompt,
            image_input: [imageUrl],
            aspect_ratio: toAspectRatio(format || "landscape"),
          },
        };
        console.log(`[ImageGen] Replicate edit attempt ${attempt}: prompt="${editPrompt.substring(0, 60)}" image_input=[${imageUrl.substring(0, 50)}...]`);

        const res = await fetch(REPLICATE_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${replicateApiKey}`,
            "Content-Type": "application/json",
            Prefer: "wait",
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          console.warn(`[ImageGen] Replicate edit attempt ${attempt} failed (${res.status}): ${errBody.substring(0, 300)}`);
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            console.warn(`[ImageGen] Replicate edit giving up on ${res.status} (client error, non-retriable)`);
            break;
          }
          if (attempt < 3) { await sleep(2000 * attempt); continue; }
          break;
        }

        const prediction = await res.json() as any;
        const editOutputUrl = typeof prediction.output === "string"
          ? prediction.output
          : Array.isArray(prediction.output) ? prediction.output[0] : null;
        console.log(`[ImageGen] Replicate edit response: status=${prediction.status}, outputUrl=${editOutputUrl?.substring(0, 60)}`);

        if (prediction.status === "succeeded" && editOutputUrl) {
          const imgRes = await fetch(editOutputUrl);
          if (imgRes.ok) {
            const bytes = new Uint8Array(await imgRes.arrayBuffer());
            const url = await uploadToStorage(bytes, projectId);
            console.log(`[ImageGen] ✅ Replicate edit success (attempt ${attempt})`);
            return url;
          }
        }

        if (prediction.id && prediction.status !== "failed") {
          const url = await pollReplicate(prediction.id, replicateApiKey, projectId);
          if (url) {
            console.log(`[ImageGen] ✅ Replicate edit success (polled, attempt ${attempt})`);
            return url;
          }
        }

        if (attempt < 3) await sleep(2000 * attempt);
      } catch (err) {
        console.warn(`[ImageGen] Replicate edit attempt ${attempt} threw: ${err}`);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }
    console.warn("[ImageGen] Replicate edit exhausted — falling back to Hypereal");
  }

  // Fallback: Hypereal (re-generates from full prompt, no source image)
  if (hyperealApiKey && originalPrompt) {
    const fullPrompt = `${originalPrompt}\n\nMODIFICATION: ${editInstruction}\n\nSTYLE: ${styleDesc || ""}`;
    console.log(`[ImageGen] Hypereal edit fallback: prompt length=${fullPrompt.length}`);
    const bytes = await tryHypereal(fullPrompt, hyperealApiKey, format || "landscape");
    if (bytes) {
      console.log(`[ImageGen] ✅ Hypereal edit fallback success`);
      return await uploadToStorage(bytes, projectId);
    }
  }

  throw new Error("Image edit failed: both Replicate and Hypereal exhausted");
}
