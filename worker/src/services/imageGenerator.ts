/**
 * Image generation service for the worker.
 *
 * Provider chain (highest priority first):
 *   1. Hypereal `gpt-image-2` — primary. OpenAI flagship image gen
 *      via Hypereal. Uses `size` param ("1024x1024" | "1536x1024"
 *      landscape | "1024x1536" portrait), accepts an optional
 *      `reference_images: string[]` for character-consistency
 *      image-to-image renders. NOT `aspect_ratio`.
 *   2. Hypereal `gemini-3-1-flash-t2i` — backup. Uses `aspect_ratio`.
 *      Text-only — no reference-image support.
 *   3. Replicate `nano-banana-2` — last-resort tertiary, also the
 *      pre-existing reference-image path. Now superseded by
 *      gpt-image-2 for reference renders but kept in the chain as
 *      a safety net.
 *
 * IMPORTANT: Hypereal CDN URLs (r2.dev) have hotlink protection —
 * browsers sending a Referer from motionmax.io get blocked.
 * We ALWAYS download image bytes and re-upload to Supabase Storage
 * so the frontend loads from our own domain (no restriction).
 */

import { supabase } from "../lib/supabase.js";
import { writeApiLog } from "../lib/logger.js";
import { isEnabled } from "../lib/featureFlags.js";
import { v4 as uuidv4 } from "uuid";

// ── Constants ──────────────────────────────────────────────────────

const HYPEREAL_API_URL = "https://api.hypereal.cloud/v1/images/generate";

// Image-gen-only Hypereal key. We bill image generation (gpt-image-2
// primary + Gemini 3.1 Flash fallback) against a separate Hypereal
// account from video / edit / lipsync / ASR / music. When set,
// HYPEREALIMAGE_API_KEY overrides the apiKey passed in by the
// handler. When unset we fall back to the handler's key (which still
// reads HYPEREAL_API_KEY) so a single-key deployment keeps working.
const HYPEREAL_IMAGE_KEY = (process.env.HYPEREALIMAGE_API_KEY || "").trim();

// Primary: OpenAI gpt-image-2 via Hypereal. Supports
// 1024x1024 / 1536x1024 (landscape) / 1024x1536 (portrait), plus an
// optional reference_images array for image-to-image / character-
// consistency renders.
const HYPEREAL_GPT_IMAGE2_MODEL = "gpt-image-2";
// Match Gemini's retry budget (4) + exponential-with-jitter backoff
// so the only intentional difference between the two providers is
// the `size` vs `aspect_ratio` payload field. Per-attempt log lines
// will look identical aside from the model name.
const HYPEREAL_GPT_IMAGE2_RETRIES = 4;
// Backup: Gemini 3.1 Flash text-to-image (the previous primary). Same
// Hypereal endpoint but uses `aspect_ratio` instead of `size`.
const HYPEREAL_MODEL = "gemini-3-1-flash-t2i";
const HYPEREAL_RETRIES = 4;

const REPLICATE_API_URL = "https://api.replicate.com/v1/models/google/nano-banana-2/predictions";
const REPLICATE_POLL_URL = "https://api.replicate.com/v1/predictions";
const REPLICATE_RETRIES = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Prompt/result cache ────────────────────────────────────────────
// In-memory cache so identical (prompt, format) pairs skip the provider
// API and return the already-uploaded Supabase URL. Also deduplicates
// concurrent in-flight requests for the same key.

const CACHE_MAX_SIZE = 500;
const _promptCache = new Map<string, string>();         // key → Supabase URL
const _inFlight = new Map<string, Promise<string>>();   // key → pending Promise

function _cacheKey(prompt: string, format: string): string {
  return `${format}|${prompt}`;
}

function _cacheGet(key: string): string | undefined {
  return _promptCache.get(key);
}

function _cacheSet(key: string, url: string): void {
  if (_promptCache.size >= CACHE_MAX_SIZE) {
    // Evict oldest entry — Map preserves insertion order
    const firstKey = _promptCache.keys().next().value!;
    _promptCache.delete(firstKey);
  }
  _promptCache.set(key, url);
}

// ── Global Hypereal concurrency limiter ───────────────────────────
// Caps simultaneous outbound Hypereal API calls process-wide.
// Without this: 20 concurrent jobs × 5 scenes = 100 parallel requests,
// which triggers provider rate-limit 429s and wastes retry budget.

const HYPEREAL_MAX_CONCURRENT = 10;
let _hyperealActive = 0;
const _hyperealQueue: Array<() => void> = [];

function acquireHypereal(): Promise<void> {
  if (_hyperealActive < HYPEREAL_MAX_CONCURRENT) {
    _hyperealActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _hyperealQueue.push(() => { _hyperealActive++; resolve(); });
  });
}

function releaseHypereal(): void {
  _hyperealActive--;
  const next = _hyperealQueue.shift();
  if (next) next();
}

// ── Aspect ratio ──────────────────────────────────────────────────

function toAspectRatio(format: string): string {
  if (format === "portrait") return "9:16";
  if (format === "square") return "1:1";
  return "16:9";
}

/** Map our format keys to gpt-image-2's allowed `size` values.
 *  Hypereal's gpt-image-2 accepts only these three sizes; anything
 *  else is rejected upstream. Square is the default. */
function toGptImage2Size(format: string): "1024x1024" | "1536x1024" | "1024x1536" {
  if (format === "portrait") return "1024x1536";
  if (format === "landscape") return "1536x1024";
  return "1024x1024";
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

// ── Hypereal — gpt-image-2 (primary) ──────────────────────────────

/** Generate from Hypereal `gpt-image-2`. Returns raw image bytes
 *  (already downloaded — caller re-uploads to Supabase to dodge the
 *  r2.dev hotlink-protection block). Same API URL + key as the
 *  Gemini backup; differences are: `model: "gpt-image-2"`, `size`
 *  (instead of `aspect_ratio`), and an optional `reference_images`
 *  array for character-consistency image-to-image renders.
 *  Retry budget + backoff intentionally identical to tryHypereal so
 *  the only behavioural delta between primary and backup is the
 *  request payload. */
async function tryHyperealGptImage2(
  prompt: string,
  apiKey: string,
  format: string,
  referenceImages?: string[],
): Promise<Uint8Array | null> {
  // Image-gen-only override — see HYPEREAL_IMAGE_KEY comment up top.
  const effectiveKey = HYPEREAL_IMAGE_KEY || apiKey;
  const size = toGptImage2Size(format);

  // OpenAI gpt-image-1 (which Hypereal proxies as gpt-image-2) caps
  // prompt at 4000 chars. Anything longer comes back as
  //   500 E1004 "Invalid input parameters. Please check your request."
  // Truncate at 3900 to leave a 100-char safety margin and break at
  // the last sentence boundary so the trailing fragment still reads
  // naturally. The TEMPORAL CONSISTENCY rules added to
  // buildCinematic.ts pushed many scene prompts past 4000 chars in
  // production — this defends both old and new prompt sources.
  const PROMPT_CAP = 3900;
  let safePrompt = prompt;
  if (prompt.length > PROMPT_CAP) {
    const slice = prompt.slice(0, PROMPT_CAP);
    const lastBoundary = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? "),
      slice.lastIndexOf(".\n"),
    );
    safePrompt = (lastBoundary > PROMPT_CAP * 0.6
      ? slice.slice(0, lastBoundary + 1)
      : slice).trimEnd();
    console.warn(
      `[ImageGen] gpt-image-2 prompt truncated ${prompt.length} → ${safePrompt.length} chars (4000 char cap)`,
    );
  }

  // gpt-image-2's reference_images parameter requires PUBLIC URLs
  // only — per spec, "public URLs only" (no base64 data URIs).
  // Character images uploaded via the intake form are stored as
  // `data:image/jpeg;base64,...` strings on projects.character_images,
  // so we have to filter to http(s) URLs before forwarding. Sending
  // a data: URI returns 500 E1004 "Invalid input parameters" and
  // burns the entire retry budget. An all-data-URI array becomes an
  // empty array, which we then omit (an empty array is also a 400).
  const publicRefs = (referenceImages ?? []).filter((u) =>
    typeof u === "string" && /^https?:\/\//i.test(u),
  );
  if ((referenceImages?.length ?? 0) > publicRefs.length) {
    console.warn(
      `[ImageGen] gpt-image-2 dropped ${(referenceImages?.length ?? 0) - publicRefs.length} non-public reference image(s) (data:/blob: not allowed by spec)`,
    );
  }

  const requestBody: Record<string, unknown> = {
    prompt: safePrompt,
    model: HYPEREAL_GPT_IMAGE2_MODEL,
    size,
  };
  if (publicRefs.length > 0) {
    requestBody.reference_images = publicRefs;
  }

  for (let attempt = 1; attempt <= HYPEREAL_GPT_IMAGE2_RETRIES; attempt++) {
    try {
      const res = await fetch(HYPEREAL_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${effectiveKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        const err = await res.text();
        console.warn(`[ImageGen] gpt-image-2 attempt ${attempt} failed (${res.status}): ${err.substring(0, 200)}`);
        // Do not retry on 4xx client errors — they won't succeed on retry
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          console.warn(`[ImageGen] gpt-image-2 giving up on ${res.status} (client error, non-retriable)`);
          return null;
        }
        // Hypereal's E9999 ("unexpected error") signals an upstream
        // outage that doesn't recover within a few seconds — fall to
        // Gemini after one retry instead of burning all 4 attempts.
        // Same short-circuit tryHypereal (Gemini) uses; kept symmetric.
        if (err.includes("E9999") && attempt >= 2) {
          console.warn(`[ImageGen] gpt-image-2 E9999 sustained — failing over to Gemini early`);
          return null;
        }
        // Exponential backoff with mild jitter: 1s, 2s, 4s, 8s ± 30%.
        // Identical to tryHypereal's Gemini path.
        if (attempt < HYPEREAL_GPT_IMAGE2_RETRIES) {
          const base = 1000 * Math.pow(2, attempt - 1);
          const jitter = base * (0.7 + Math.random() * 0.6);
          await sleep(Math.round(jitter));
        }
        continue;
      }

      const data = await res.json() as any;
      // OpenAI-compatible response shape: data.data[0].url. Some
      // providers also return data.data[0].b64_json — handle both.
      const url = data?.data?.[0]?.url as string | undefined;
      const b64 = data?.data?.[0]?.b64_json as string | undefined;

      if (b64) {
        const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
        console.log(`[ImageGen] gpt-image-2 ✅ attempt ${attempt} (b64) — ${bytes.length} bytes`);
        return bytes;
      }

      if (!url) {
        console.warn(`[ImageGen] gpt-image-2 attempt ${attempt}: no url/b64 in response`);
        if (attempt < HYPEREAL_GPT_IMAGE2_RETRIES) await sleep(1500 * attempt);
        continue;
      }

      const imgRes = await fetch(url);
      if (!imgRes.ok) {
        console.warn(`[ImageGen] gpt-image-2 download failed (${imgRes.status}) on attempt ${attempt}`);
        if (imgRes.status >= 400 && imgRes.status < 500 && imgRes.status !== 429) return null;
        if (attempt < HYPEREAL_GPT_IMAGE2_RETRIES) await sleep(1500 * attempt);
        continue;
      }

      const bytes = new Uint8Array(await imgRes.arrayBuffer());
      console.log(`[ImageGen] gpt-image-2 ✅ attempt ${attempt} — ${bytes.length} bytes`);
      return bytes;
    } catch (err) {
      console.warn(`[ImageGen] gpt-image-2 attempt ${attempt} threw: ${err}`);
      if (attempt < HYPEREAL_GPT_IMAGE2_RETRIES) await sleep(1500 * attempt);
    }
  }

  return null;
}

// ── Hypereal — Gemini 3.1 Flash (backup) ───────────────────────────

/** Generate from Hypereal, download bytes, return raw bytes (not URL). */
async function tryHypereal(
  prompt: string,
  apiKey: string,
  format: string,
): Promise<Uint8Array | null> {
  // Image-gen-only override — see HYPEREAL_IMAGE_KEY comment up top.
  const effectiveKey = HYPEREAL_IMAGE_KEY || apiKey;
  const aspectRatio = toAspectRatio(format);

  // Log masked key on first attempt for debugging
  const keyLen = effectiveKey.length;
  const maskedKey = keyLen === 0 ? "(EMPTY)" : keyLen <= 12
    ? `${effectiveKey.substring(0, 3)}…${effectiveKey.substring(keyLen - 3)} (${keyLen}ch)`
    : `${effectiveKey.substring(0, 6)}…${effectiveKey.substring(keyLen - 4)} (${keyLen}ch)`;
  console.log(`[ImageGen] Hypereal key in use: ${maskedKey}`);

  for (let attempt = 1; attempt <= HYPEREAL_RETRIES; attempt++) {
    try {
      const res = await fetch(HYPEREAL_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${effectiveKey}`, "Content-Type": "application/json" },
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
        // Hypereal's E9999 ("unexpected error") signals an upstream
        // outage that doesn't recover within a few seconds — fall to
        // Replicate after one retry instead of burning 4 attempts and
        // making every queued scene wait ~9s during their hiccup.
        if (err.includes("E9999") && attempt >= 2) {
          console.warn(`[ImageGen] Hypereal E9999 sustained — failing over to Replicate early`);
          return null;
        }
        // Exponential backoff with mild jitter: 1s, 2s, 4s, 8s ± 30%.
        // Linear backoff was too kind to a struggling upstream and
        // never gave it real time to recover between attempts.
        if (attempt < HYPEREAL_RETRIES) {
          const base = 1000 * Math.pow(2, attempt - 1);
          const jitter = base * (0.7 + Math.random() * 0.6);
          await sleep(Math.round(jitter));
        }
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
 * Results are cached in-memory by (prompt, format) to skip redundant API
 * calls for identical prompts within the same worker process lifetime.
 */
export async function generateImage(
  prompt: string,
  hyperealApiKey: string,
  replicateApiKey: string,
  format: string,
  projectId: string,
  referenceImages?: string[],
): Promise<string> {
  const key = _cacheKey(prompt, format);

  // Cache hit — return immediately without any API call
  const cached = _cacheGet(key);
  if (cached) {
    console.log(`[ImageGen] Cache hit for prompt (${prompt.length} chars, format=${format})`);
    return cached;
  }

  // In-flight deduplication — coalesce concurrent requests for the same key
  const existing = _inFlight.get(key);
  if (existing) {
    console.log(`[ImageGen] Coalescing in-flight request for same prompt (${prompt.length} chars)`);
    return existing;
  }

  const work = _generateImageUncached(prompt, hyperealApiKey, replicateApiKey, format, projectId, referenceImages);
  _inFlight.set(key, work);

  try {
    const url = await work;
    _cacheSet(key, url);
    return url;
  } finally {
    _inFlight.delete(key);
  }
}

async function _generateImageUncached(
  prompt: string,
  hyperealApiKey: string,
  replicateApiKey: string,
  format: string,
  projectId: string,
  referenceImages?: string[],
): Promise<string> {
  const startTime = Date.now();

  // Kill-switch: disable all image generation without redeploying the worker.
  // Toggle via DB feature_flags row or FLAG_IMAGE_GENERATION=false env var.
  if (!(await isEnabled("image_generation"))) {
    throw new Error("Image generation is disabled via feature flag (image_generation=false)");
  }

  const replicateEnabled = await isEnabled("image_provider_replicate");

  // Hypereal master kill-switch + per-model flags. The Hypereal
  // concurrency limiter is shared across both routes since they hit
  // the same upstream account / rate-limit pool.
  const hyperealEnabled = await isEnabled("image_provider_hypereal");
  const gptImage2Enabled = await isEnabled("image_provider_gpt_image2", true);
  const geminiEnabled = await isEnabled("image_provider_gemini", true);

  // ── Primary: Hypereal gpt-image-2 ─────────────────────────────────
  // gpt-image-2 supports the optional `reference_images` array, so
  // character-consistency renders go through this path too — no
  // separate Replicate detour for refs.
  if (hyperealApiKey && hyperealEnabled && gptImage2Enabled) {
    await acquireHypereal();
    const bytes = await tryHyperealGptImage2(prompt, hyperealApiKey, format, referenceImages).finally(releaseHypereal);
    if (bytes) {
      const url = await uploadToStorage(bytes, projectId);
      writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: HYPEREAL_GPT_IMAGE2_MODEL, status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[ImageGen] background log failed:', (err as Error).message); });
      return url;
    }
    console.warn("[ImageGen] gpt-image-2 exhausted — falling back to Gemini 3.1 Flash");
  } else if (!gptImage2Enabled) {
    console.warn("[ImageGen] gpt-image-2 disabled via feature flag — skipping to Gemini");
  }

  // ── Backup: Hypereal Gemini 3.1 Flash ─────────────────────────────
  // Text-only — no reference-image support. If the caller has refs,
  // we still try this path; the result will be a fresh render that
  // ignores the refs. That's strictly better than failing the scene.
  if (hyperealApiKey && hyperealEnabled && geminiEnabled) {
    await acquireHypereal();
    const bytes = await tryHypereal(prompt, hyperealApiKey, format).finally(releaseHypereal);
    if (bytes) {
      const url = await uploadToStorage(bytes, projectId);
      writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: HYPEREAL_MODEL, status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[ImageGen] background log failed:', (err as Error).message); });
      return url;
    }
    console.warn("[ImageGen] Gemini 3.1 Flash exhausted — last-resort tertiary will run");
  } else if (!hyperealEnabled) {
    console.warn("[ImageGen] Hypereal disabled via feature flag");
  } else if (!geminiEnabled) {
    console.warn("[ImageGen] Gemini 3.1 Flash disabled via feature flag");
  }

  // ── Last-resort tertiary fallback (untouched legacy path) ────────
  if (replicateApiKey && replicateEnabled) {
    const url = await tryReplicate(prompt, replicateApiKey, format, projectId, referenceImages);
    if (url) {
      writeApiLog({ userId: undefined, generationId: undefined, provider: "replicate", model: "nano-banana-2", status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[ImageGen] background log failed:', (err as Error).message); });
      return url;
    }
  } else if (!replicateEnabled) {
    console.warn("[ImageGen] Replicate disabled via feature flag");
  }

  const err = new Error("Image generation failed: gpt-image-2, Gemini 3.1 Flash, and tertiary fallback all exhausted");
  writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: HYPEREAL_GPT_IMAGE2_MODEL, status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch((err) => { console.warn('[ImageGen] background log failed:', (err as Error).message); });
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
    await acquireHypereal();
    const bytes = await tryHypereal(fullPrompt, hyperealApiKey, format || "landscape").finally(releaseHypereal);
    if (bytes) {
      console.log(`[ImageGen] ✅ Hypereal edit fallback success`);
      return await uploadToStorage(bytes, projectId);
    }
  }

  throw new Error("Image edit failed: both Replicate and Hypereal exhausted");
}
