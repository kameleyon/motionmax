import { writeApiLog } from "../lib/logger.js";

const HYPEREAL_IMAGE_URL = "https://api.hypereal.cloud/v1/images/generate";
const HYPEREAL_VIDEO_URL = "https://api.hypereal.cloud/v1/videos/generate";

const truncate = (s: string, n = 100) => s.length > n ? s.substring(0, n) + '...[truncated]' : s;

// ── Module-level rate state ────────────────────────────────────────
let lastRequestTime = 0;
const completedJobs = new Map<string, string>(); // jobId → videoUrl cache

/** Enforce minimum 2s gap between Hypereal API calls (process-wide). */
async function hyperealFetch(url: string, options: RequestInit): Promise<Response> {
  const gap = Date.now() - lastRequestTime;
  if (gap < 2_000) await new Promise(r => setTimeout(r, 2_000 - gap));
  lastRequestTime = Date.now();
  return fetch(url, options);
}

// ── Helpers ────────────────────────────────────────────────────────

/** Sleep with jitter: base ± 25% randomisation to stagger concurrent polls */
function sleepWithJitter(baseMs: number): Promise<void> {
  const jitter = baseMs * 0.25 * (Math.random() * 2 - 1);
  return new Promise(r => setTimeout(r, Math.max(2000, baseMs + jitter)));
}

/** Calculate backoff delay for 429 responses: 30s → 60s → 120s (capped) */
function backoffDelay(consecutive429: number): number {
  return Math.min(30_000 * Math.pow(2, consecutive429), 120_000);
}

/**
 * POST with built-in 429 retry. Hypereal returns 429 with
 * `{"error":{"message":"Your request is currently queued due to high
 * demand on your plan. Please retry shortly."}}` when their async pool is
 * saturated — that's a SUBMIT-time queueing signal, not a true rate limit.
 * The dispatcher's withTransientRetry is too short (3 × 2/4/8s ≈ 14s)
 * for this; Hypereal needs ~30–120s to drain. Up to 5 streak ≈ 6 min
 * total before bailing, then the dispatcher's 3 attempts cover anything
 * past that.
 */
async function hyperealPostWithRateLimit(
  url: string,
  options: RequestInit,
  label: string,
): Promise<Response> {
  const max429Streak = 5;
  let consecutive429 = 0;
  while (true) {
    const response = await hyperealFetch(url, options);
    if (response.status !== 429) return response;
    consecutive429++;
    if (consecutive429 >= max429Streak) {
      console.warn(`[Hypereal] ${label} submit — ${max429Streak} consecutive 429s, surfacing to caller`);
      return response;
    }
    const delay = backoffDelay(consecutive429 - 1);
    console.log(`[Hypereal] ${label} submit — 429 queued, backoff ${Math.round(delay / 1000)}s (streak: ${consecutive429})`);
    await sleepWithJitter(delay);
  }
}

// ── Image generation ───────────────────────────────────────────────

export async function generateImage(prompt: string, apiKey: string, aspectRatio = "16:9") {
  console.log(`[Hypereal] Generating image: ${prompt.substring(0, 50)}...`);

  const response = await hyperealFetch(HYPEREAL_IMAGE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt,
      model: "gemini-3-1-flash-t2i",
      format: aspectRatio
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Image API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  if (!data?.data?.[0]?.url) {
    throw new Error("No image URL returned from Hypereal");
  }

  return data.data[0].url;
}

// ── Grok Video I2V ────────────────────────────────────────────────

/**
 * Generate video using Hypereal Grok Video I2V (xAI Grok Imagine Video).
 * Returns the video URL on success.
 */
export async function generateGrokVideo(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  aspectRatio: "16:9" | "9:16" = "16:9",
  duration: number = 10,
  resolution: string = "720P",
  endImageUrl?: string
) {
  console.log(`[Hypereal] Starting Grok Video I2V — ${duration}s, ${aspectRatio}${endImageUrl ? " (with end_image)" : ""}`);
  console.log(`[Hypereal] IMAGE URL: ${imageUrl}`);
  if (endImageUrl) console.log(`[Hypereal] END IMAGE URL: ${endImageUrl}`);

  const inputPayload: Record<string, unknown> = {
    prompt,
    image: imageUrl,
    duration,
    aspect_ratio: aspectRatio,
  };

  if (endImageUrl) {
    inputPayload.end_image = endImageUrl;
  }

  const requestBody = {
    model: "grok-video-i2v",
    input: inputPayload,
  };

  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Hypereal] FULL BODY (${bodyJson.length} chars): ${truncate(bodyJson)}`);

  const response = await hyperealFetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: bodyJson
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Grok Video API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;
  const pollUrl = data.pollUrl || null;

  console.log(`[Hypereal] Grok job created: ${jobId} (credits: ${data.creditsUsed})`);

  if (!jobId) {
    throw new Error(`No jobId from Hypereal Grok — response: ${JSON.stringify(data)}`);
  }

  return pollHyperealJob(jobId, apiKey, "grok-video-i2v", pollUrl);
}

// ── Kling V3.0 Standard I2V (primary for transitions) ─────────────

/**
 * Generate video using Kling V3.0 Standard I2V.
 * Supports native start frame + end frame interpolation for seamless transitions.
 *
 * Model: kling-3-0-std-i2v (42 credits)
 * Duration: 3-15s
 */
export async function generateKlingV3Video(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  duration: number = 5,
  endImageUrl?: string,
  negativePrompt: string = "blurry, low quality, watermark, text, UI elements",
  cfgScale: number = 0.5
): Promise<string> {
  const model = "kling-3-0-std-i2v";
  // Kling V3.0 valid durations: 3, 5, 10, 15
  const validDurations = [3, 5, 10, 15];
  const clampedDuration = validDurations.reduce((prev, curr) =>
    Math.abs(curr - duration) < Math.abs(prev - duration) ? curr : prev
  );
  if (clampedDuration !== duration) {
    console.warn(`[Hypereal] Kling V3 duration ${duration}s invalid — clamped to ${clampedDuration}s`);
  }
  console.log(`[Hypereal] Starting Kling V3.0 Std I2V — ${clampedDuration}s${endImageUrl ? " (start→end)" : ""}`);
  console.log(`[Hypereal] IMAGE: ${imageUrl.substring(0, 80)}...`);
  if (endImageUrl) console.log(`[Hypereal] END IMAGE: ${endImageUrl.substring(0, 80)}...`);

  const inputPayload: Record<string, unknown> = {
    prompt,
    image: imageUrl,
    duration: clampedDuration,
    cfg_scale: cfgScale,
    negative_prompt: negativePrompt,
    sound: false,
  };

  if (endImageUrl) {
    inputPayload.end_image = endImageUrl;
  }

  const requestBody = { model, input: inputPayload };
  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Hypereal] Kling V3 body (${bodyJson.length} chars): ${truncate(bodyJson)}`);

  const response = await hyperealFetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: bodyJson,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Kling V3 API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;
  const pollUrl = data.pollUrl || null;

  console.log(`[Hypereal] Kling V3 job created: ${jobId} (credits: ${data.creditsUsed})`);

  if (!jobId) {
    throw new Error(`No jobId from Kling V3 — response: ${JSON.stringify(data)}`);
  }

  return pollHyperealJob(jobId, apiKey, model, pollUrl);
}

// ── Kling V3.0 Pro I2V (active, end-to-end) ──────────────────────
// Restored to V3.0 Pro after a temporary V2.6 Pro cost rollback.
// V3.0 Pro delivers stronger subject consistency + texture fidelity
// at the price of more credits per scene. Function name and call sites
// stay the same (`generateKlingV3ProVideo`) — only the model string
// flips from kling-2-6-i2v-pro → kling-3-0-pro-i2v.

/** Spec-documented max prompt length for kling-3-0-pro-i2v. We truncate
 *  at 2400 chars (under the 2500 ceiling) at a sentence boundary when
 *  possible so the final chunk still reads naturally. */
const KLING_V3_PRO_MAX_PROMPT_CHARS = 2400;

function truncateKlingPrompt(input: string): string {
  if (input.length <= KLING_V3_PRO_MAX_PROMPT_CHARS) return input;
  const slice = input.slice(0, KLING_V3_PRO_MAX_PROMPT_CHARS);
  // Prefer breaking at the last sentence terminator within the window;
  // fall back to the last word boundary if there's no sentence break.
  const lastSentence = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf(".\n"),
  );
  if (lastSentence > KLING_V3_PRO_MAX_PROMPT_CHARS * 0.6) {
    return slice.slice(0, lastSentence + 1).trimEnd();
  }
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

/**
 * Generate video using Kling V3.0 Pro I2V (kling-3-0-pro-i2v).
 * Superior subject consistency + texture preservation vs V3.0 Std / V2.6 Pro.
 * Native start + end frame support.
 *
 * Model: kling-3-0-pro-i2v
 * Duration: 5 or 10 seconds (clamped to nearest valid value; default 5)
 * cfg_scale: 0.0–1.0 (clamped; default 0.5)
 *
 * Request body shape (matches Hypereal spec verbatim):
 *   { model, input: { prompt, image, end_image?, negative_prompt,
 *     duration, cfg_scale, sound } }
 *
 * sound is always false — audio is produced separately by the TTS
 * providers and muxed in at export time. Enabling sound would also
 * multiply cost by 1.5x per spec.
 */
export async function generateKlingV3ProVideo(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  duration: number = 5,
  endImageUrl?: string,
  negativePrompt: string = "blurry, low quality, watermark, text, UI elements",
  cfgScale: number = 0.5,
): Promise<string> {
  const model = "kling-3-0-pro-i2v";

  // Duration: Kling V3.0 Pro spec allows 5 or 10 only. Pick the
  // nearest valid value for any other input.
  const validDurations = [5, 10];
  const clampedDuration = validDurations.reduce((prev, curr) =>
    Math.abs(curr - duration) < Math.abs(prev - duration) ? curr : prev
  );
  if (clampedDuration !== duration) {
    console.warn(`[Hypereal] Kling V3.0 Pro duration ${duration}s invalid — clamped to ${clampedDuration}s`);
  }

  // cfg_scale: spec range 0.0–1.0. Clamp defensively (also catches NaN).
  const clampedCfgScale = Number.isFinite(cfgScale)
    ? Math.min(1, Math.max(0, cfgScale))
    : 0.5;
  if (clampedCfgScale !== cfgScale) {
    console.warn(`[Hypereal] Kling V3.0 Pro cfg_scale ${cfgScale} out of range — clamped to ${clampedCfgScale}`);
  }

  // Prompt: spec max 2500 chars. Truncate at 2400 to leave a safety
  // margin and avoid 4xx rejections on over-long prompts. Observed in
  // prod: scene prompts routinely exceed 3000 chars after the style
  // block + character bible get appended.
  const clampedPrompt = truncateKlingPrompt(prompt);
  if (clampedPrompt.length < prompt.length) {
    console.warn(`[Hypereal] Kling V2.6 Pro prompt truncated ${prompt.length} → ${clampedPrompt.length} chars (spec max 2500)`);
  }

  console.log(`[Hypereal] Starting Kling V2.6 Pro I2V — ${clampedDuration}s${endImageUrl ? " (start→end)" : ""} cfg_scale=${clampedCfgScale}`);
  console.log(`[Hypereal] IMAGE: ${imageUrl.substring(0, 80)}...`);
  if (endImageUrl) console.log(`[Hypereal] END IMAGE: ${endImageUrl.substring(0, 80)}...`);

  // Build request body in the exact order Hypereal documents.
  const inputPayload: Record<string, unknown> = {
    prompt: clampedPrompt,
    image: imageUrl,
    duration: clampedDuration,
    cfg_scale: clampedCfgScale,
    negative_prompt: negativePrompt,
    // sound is always false — we mux audio separately at export time
    // and we do not want the 1.5x cost multiplier.
    sound: false,
  };

  // end_image is optional; only include when the caller supplied one.
  if (endImageUrl) {
    inputPayload.end_image = endImageUrl;
  }

  const requestBody = { model, input: inputPayload };
  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Hypereal] Kling V2.6 Pro body (${bodyJson.length} chars): ${truncate(bodyJson)}`);

  const response = await hyperealFetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: bodyJson,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Kling V2.6 Pro API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;
  const pollUrl = data.pollUrl || null;

  console.log(`[Hypereal] Kling V2.6 Pro job created: ${jobId} (credits: ${data.creditsUsed})`);

  if (!jobId) {
    throw new Error(`No jobId from Kling V2.6 Pro — response: ${JSON.stringify(data)}`);
  }

  return pollHyperealJob(jobId, apiKey, model, pollUrl);
}

// ── Seedance 2.0 Fast I2V (active scene renderer) ────────────────
// ByteDance Seedance 2.0 Fast image-to-video via the Hypereal proxy.
// Active scene-renderer model (~53 credits/scene, vs Kling 3.0 Pro's
// ~57). Same Hypereal envelope as Kling — { model, input } posted to
// HYPEREAL_VIDEO_URL — only the model id and input keys differ.
//
// Audio: we always pass generate_audio=false. Motionmax produces
// voiceover via the TTS pipeline and muxes it in at export, so an
// extra video-track soundtrack would clash and pay for synthesis we
// throw away.

export type SeedanceAspectRatio = "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
export type SeedanceResolution = "480p" | "720p";

const SEEDANCE_MAX_PROMPT_CHARS = 2400;

/**
 * Generate video via Seedance 2.0 Fast I2V (`seedance-2-0-fast-i2v`).
 *
 *  duration:     5–10s (clamped; default 10)
 *  resolution:   "480p" | "720p" (default "720p")
 *  aspectRatio:  "16:9" | "9:16" | "1:1" | "4:3" | "3:4" (default "16:9")
 *  endImageUrl:  optional last frame for start→end interpolation
 *  generateAudio: false (synthesized audio is muxed by the export
 *                 pipeline — overriding to true is rarely what you want)
 *
 * Returns the rendered video URL after polling the Hypereal job.
 */
export async function generateSeedance2FastI2V(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  duration: number = 10,
  endImageUrl?: string,
  aspectRatio: SeedanceAspectRatio = "16:9",
  resolution: SeedanceResolution = "720p",
  generateAudio: boolean = false,
): Promise<string> {
  const model = "seedance-2-0-fast-i2v";

  // Duration: spec range 5–10s (continuous). Clamp + warn if outside.
  const clampedDuration = Math.min(10, Math.max(5, Math.round(duration)));
  if (clampedDuration !== duration) {
    console.warn(`[Hypereal] Seedance 2.0 duration ${duration}s out of range — clamped to ${clampedDuration}s`);
  }

  const clampedPrompt = truncateKlingPrompt(prompt); // share the same 2400-char ceiling
  if (clampedPrompt.length < prompt.length) {
    console.warn(`[Hypereal] Seedance 2.0 prompt truncated ${prompt.length} → ${clampedPrompt.length} chars`);
  }

  console.log(
    `[Hypereal] Starting Seedance 2.0 Fast I2V — ${clampedDuration}s, ${resolution}, ${aspectRatio}` +
    `${endImageUrl ? " (start→end)" : ""}${generateAudio ? " +audio" : ""}`,
  );
  console.log(`[Hypereal] IMAGE: ${imageUrl.substring(0, 80)}...`);
  if (endImageUrl) console.log(`[Hypereal] LAST IMAGE: ${endImageUrl.substring(0, 80)}...`);

  const inputPayload: Record<string, unknown> = {
    prompt: clampedPrompt,
    image: imageUrl,
    duration: clampedDuration,
    resolution,
    aspect_ratio: aspectRatio,
    generate_audio: generateAudio,
  };
  if (endImageUrl) {
    inputPayload.last_image = endImageUrl;
  }

  const requestBody = { model, input: inputPayload };
  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Hypereal] Seedance 2.0 body (${bodyJson.length} chars): ${truncate(bodyJson)}`);

  const response = await hyperealPostWithRateLimit(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: bodyJson,
  }, "seedance-2-0-fast-i2v");

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Seedance 2.0 Fast I2V API Error: ${response.status} - ${errorText}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as any;
  const jobId = data.jobId;
  const pollUrl = data.pollUrl || null;

  console.log(`[Hypereal] Seedance 2.0 job created: ${jobId} (credits: ${data.creditsUsed})`);

  if (!jobId) {
    throw new Error(`No jobId from Seedance 2.0 — response: ${JSON.stringify(data)}`);
  }

  return pollHyperealJob(jobId, apiKey, model, pollUrl);
}

// ── Grok Imagine Video Edit (text-prompt video editing) ──────────

/**
 * Edit an existing video via Hypereal `grok-imagine-video-edit`.
 *
 * xAI's Grok Imagine video-edit endpoint takes a video URL plus a
 * natural-language instruction and returns a modified clip — much
 * faster + cheaper than re-rendering an image-to-video pass with
 * Kling. We wire it through the same Hypereal endpoint as Kling V3
 * Pro (same URL, same Bearer auth, same { model, input } body
 * envelope, same pollHyperealJob for the result). The only delta vs
 * Kling is `model` plus a `video` field in `input` instead of
 * `image` + `end_image`.
 *
 * Model: grok-imagine-video-edit (55 credits, $0.55/edit)
 * Required: prompt, video (URL of the source clip)
 *
 * Returns the edited video URL.
 */
export async function editVideoWithGrokImagine(
  videoUrl: string,
  prompt: string,
  apiKey: string,
): Promise<string> {
  const model = "grok-imagine-video-edit";
  const clampedPrompt = truncateKlingPrompt(prompt); // same 2400-char ceiling — shared upstream limit

  console.log(`[Hypereal] Starting Grok Imagine video edit`);
  console.log(`[Hypereal] VIDEO: ${videoUrl.substring(0, 80)}...`);
  console.log(`[Hypereal] PROMPT (${clampedPrompt.length} chars): ${truncate(clampedPrompt)}`);

  // Mirror the Kling V3 Pro request envelope verbatim. Only the input
  // payload shape differs: { prompt, video } instead of
  // { prompt, image, end_image, ... }.
  const requestBody = {
    model,
    input: {
      prompt: clampedPrompt,
      video: videoUrl,
    },
  };
  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Hypereal] grok-imagine-video-edit body (${bodyJson.length} chars): ${truncate(bodyJson)}`);

  const response = await hyperealFetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: bodyJson,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal grok-imagine-video-edit API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;
  const pollUrl = data.pollUrl || null;

  console.log(`[Hypereal] grok-imagine-video-edit job created: ${jobId} (credits: ${data.creditsUsed})`);

  if (!jobId) {
    throw new Error(`No jobId from grok-imagine-video-edit — response: ${JSON.stringify(data)}`);
  }

  return pollHyperealJob(jobId, apiKey, model, pollUrl);
}

// ── Kling V2.6 Pro I2V (fallback for transitions) ─────────────────

/**
 * Generate video using Kling V2.6 Pro I2V.
 * Fallback for transitions — strong detail preservation with native end_image support.
 *
 * Model: kling-2-6-i2v-pro (35 credits)
 * Duration: 5 or 10s
 * Note: end_image cannot be used with sound (sound=false when using end_image)
 */
export async function generateKlingV26Video(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  duration: number = 5,
  endImageUrl?: string,
  negativePrompt: string = "blurry, low quality, watermark, text, UI elements",
  cfgScale: number = 0.5
): Promise<string> {
  const model = "kling-2-6-i2v-pro";
  // Kling V2.6 valid durations: 5, 10
  const validDurations = [5, 10];
  const clampedDuration = validDurations.reduce((prev, curr) =>
    Math.abs(curr - duration) < Math.abs(prev - duration) ? curr : prev
  );
  if (clampedDuration !== duration) {
    console.warn(`[Hypereal] Kling V2.6 duration ${duration}s invalid — clamped to ${clampedDuration}s`);
  }
  console.log(`[Hypereal] Starting Kling V2.6 Pro I2V — ${clampedDuration}s${endImageUrl ? " (start→end)" : ""}`);
  console.log(`[Hypereal] IMAGE: ${imageUrl.substring(0, 80)}...`);
  if (endImageUrl) console.log(`[Hypereal] END IMAGE: ${endImageUrl.substring(0, 80)}...`);

  const inputPayload: Record<string, unknown> = {
    prompt,
    image: imageUrl,
    duration: clampedDuration,
    cfg_scale: cfgScale,
    negative_prompt: negativePrompt,
    // sound is always false — we generate audio separately via the TTS
    // providers (Smallest / Fish / LemonFox / Gemini) and mux it in at
    // export time. Keeping sound off also avoids Kling's 2x cost
    // multiplier and dodges the "cannot use with end_image" restriction.
    sound: false,
  };

  if (endImageUrl) {
    inputPayload.end_image = endImageUrl;
  }

  const requestBody = { model, input: inputPayload };
  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Hypereal] Kling V2.6 body (${bodyJson.length} chars): ${truncate(bodyJson)}`);

  const response = await hyperealFetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: bodyJson,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Kling V2.6 API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;
  const pollUrl = data.pollUrl || null;

  console.log(`[Hypereal] Kling V2.6 job created: ${jobId} (credits: ${data.creditsUsed})`);

  if (!jobId) {
    throw new Error(`No jobId from Kling V2.6 — response: ${JSON.stringify(data)}`);
  }

  return pollHyperealJob(jobId, apiKey, model, pollUrl);
}

// ── Generic Hypereal Job Poller ───────────────────────────────────

/**
 * Poll a Hypereal video generation job until completion.
 * Works for Grok, Kling V3, Kling V2.6 — same polling API.
 */
async function pollHyperealJob(
  jobId: string,
  apiKey: string,
  model: string,
  pollUrl: string | null,
): Promise<string> {
  // Return immediately if this job already completed in this process
  const cached = completedJobs.get(jobId);
  if (cached) return cached;

  const pollStartTime = Date.now();
  const maxAttempts = 40;
  const max429Streak = 4;
  let consecutive429 = 0;

  const url = pollUrl
    || `https://api.hypereal.cloud/v1/jobs/${jobId}?model=${model}&type=video`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (consecutive429 > 0) {
      const delay = backoffDelay(consecutive429);
      if (consecutive429 <= 3 || consecutive429 % 5 === 0) {
        console.log(`[Hypereal] ${model} ${jobId} — 429 backoff ${Math.round(delay / 1000)}s (streak: ${consecutive429})`);
      }
      await sleepWithJitter(delay);
    } else {
      // Exponential backoff: 5s → 10s → 20s → 30s cap
      const pollMs = Math.min(5_000 * Math.pow(2, attempt - 1), 30_000);
      await sleepWithJitter(pollMs);
    }

    if (attempt <= 2 || attempt % 5 === 0) {
      console.log(`[Hypereal] Polling ${model} ${jobId} (${attempt}/${maxAttempts})...`);
    }

    const response = await hyperealFetch(url, {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });

    if (response.status === 429) {
      consecutive429++;
      if (consecutive429 >= max429Streak) {
        console.warn(`[Hypereal] ${model} ${jobId} — ${max429Streak} consecutive 429s, bailing`);
        const rlErr = new Error(`Hypereal rate-limited: ${max429Streak} consecutive 429 responses`);
        writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model, status: "error", totalDurationMs: Date.now() - pollStartTime, cost: 0, error: rlErr.message }).catch((err) => { console.warn('[Hypereal] background log failed:', (err as Error).message); });
        throw rlErr;
      }
      continue;
    }

    if (!response.ok) {
      console.warn(`[Hypereal] ${model} poll ${jobId} — HTTP ${response.status}`);
      consecutive429 = 0;
      continue;
    }

    consecutive429 = 0;
    const data = await response.json() as any;

    if (data.status === "succeeded" || data.status === "completed") {
      const videoUrl = data.outputUrl || data.output_url || data.result?.url || data.output?.url || data.url;
      console.log(`[Hypereal] ✅ ${model} ${data.status} ${jobId} — ${String(videoUrl).substring(0, 80)}...`);
      if (!videoUrl) {
        console.log(`[Hypereal] Full response: ${JSON.stringify(data)}`);
        const err = new Error(`${model} job ${data.status} but no URL found in response`);
        writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model, status: "error", totalDurationMs: Date.now() - pollStartTime, cost: 0, error: err.message }).catch((err) => { console.warn('[Hypereal] background log failed:', (err as Error).message); });
        throw err;
      }
      writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model, status: "success", totalDurationMs: Date.now() - pollStartTime, cost: 0, error: undefined }).catch((err) => { console.warn('[Hypereal] background log failed:', (err as Error).message); });
      completedJobs.set(jobId, videoUrl);
      return videoUrl;
    }

    if (data.status === "failed" || data.status === "error") {
      // Hypereal's status endpoint has a known quirk: on the first one or
      // two polls of a freshly-created job it can return
      //   { status: "failed", error: "Failed to check status" }
      // when the job is actually still queuing on their end. Treating
      // THAT as a terminal failure kills every Grok video immediately —
      // observed in prod where 6 jobs all died on poll #1 with the same
      // "Failed to check status" body. Keep polling on transient lookup
      // errors; only fail hard on a concrete upstream failure.
      const errText: string = (typeof data.error === "string" ? data.error : "").trim();
      const errLower = errText.toLowerCase();
      const isTransientLookup =
        errLower.includes("failed to check status") ||
        errLower.includes("not found") ||
        errLower.includes("pending") ||
        errLower.includes("in progress") ||
        errLower === ""; // empty error body on a "failed" status — very likely a lookup blip

      if (isTransientLookup && attempt <= 6) {
        // First 6 attempts: assume the job exists, the checker doesn't.
        // Log once per streak instead of on every poll to avoid spam.
        if (attempt === 1 || attempt % 3 === 0) {
          console.warn(`[Hypereal] ${model} ${jobId} poll ${attempt}/${maxAttempts}: transient lookup error "${errText || "<empty>"}" — will retry`);
        }
        continue;
      }

      const err = new Error(`${model} job failed: ${errText || JSON.stringify(data)}`);
      writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model, status: "error", totalDurationMs: Date.now() - pollStartTime, cost: 0, error: err.message }).catch((err) => { console.warn('[Hypereal] background log failed:', (err as Error).message); });
      throw err;
    }

    if (attempt % 10 === 0) {
      console.log(`[Hypereal] ${model} ${jobId} status: ${data.status} (attempt ${attempt})`);
    }
  }

  const timeoutErr = new Error(`${model} timed out after ${maxAttempts} polls (~${Math.round(maxAttempts * 30_000 / 60_000)} min).`);
  writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model, status: "error", totalDurationMs: Date.now() - pollStartTime, cost: 0, error: timeoutErr.message }).catch((err) => { console.warn('[Hypereal] background log failed:', (err as Error).message); });
  throw timeoutErr;
}

// ── Kling V2.5 Turbo Pro I2V (fallback for V2.6) ────────────────────

/**
 * Generate video using Kling V2.5 Turbo Pro I2V.
 * Fallback when V2.6 fails — smooth visual transformation with last_image support.
 *
 * Model: kling-2-5-i2v (35 credits)
 * Duration: 5 or 10s
 * Note: No sound parameter — V2.5 Turbo doesn't support audio generation.
 *       Uses `last_image` (not `end_image`) for end-frame transitions.
 */
export async function generateKlingV25Video(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  duration: number = 10,
  lastImageUrl?: string,
  negativePrompt: string = "blurry, low quality, watermark, text, UI elements",
  guidanceScale: number = 0.5
): Promise<string> {
  const model = "kling-2-5-i2v";
  // Kling V2.5 valid durations: 5, 10
  const validDurations = [5, 10];
  const clampedDuration = validDurations.reduce((prev, curr) =>
    Math.abs(curr - duration) < Math.abs(prev - duration) ? curr : prev
  );
  if (clampedDuration !== duration) {
    console.warn(`[Hypereal] Kling V2.5 duration ${duration}s invalid — clamped to ${clampedDuration}s`);
  }
  console.log(`[Hypereal] Starting Kling V2.5 Turbo Pro I2V — ${clampedDuration}s${lastImageUrl ? " (start→end)" : ""}`);
  console.log(`[Hypereal] IMAGE: ${imageUrl.substring(0, 80)}...`);
  if (lastImageUrl) console.log(`[Hypereal] LAST IMAGE: ${lastImageUrl.substring(0, 80)}...`);

  const inputPayload: Record<string, unknown> = {
    prompt,
    image: imageUrl,
    duration: clampedDuration,
    guidance_scale: guidanceScale,
    negative_prompt: negativePrompt,
  };

  if (lastImageUrl) {
    inputPayload.last_image = lastImageUrl;
  }

  const requestBody = { model, input: inputPayload };
  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Hypereal] Kling V2.5 body (${bodyJson.length} chars): ${truncate(bodyJson)}`);

  const response = await hyperealFetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: bodyJson,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Kling V2.5 API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;
  const pollUrl = data.pollUrl || null;

  console.log(`[Hypereal] Kling V2.5 job created: ${jobId} (credits: ${data.creditsUsed})`);

  if (!jobId) {
    throw new Error(`No jobId from Kling V2.5 — response: ${JSON.stringify(data)}`);
  }

  return pollHyperealJob(jobId, apiKey, model, pollUrl);
}

// ── Veo 3.1 Fast I2V (Google, primary for cinematic) ──────────────

/**
 * Generate video using Google Veo 3.1 Fast I2V via Hypereal.
 *
 * Model: veo-3-1-i2v (72 credits without audio, 72 credits with audio)
 * Duration: 4, 6, 8s
 * Supports native last_image for seamless transitions.
 * Audio disabled to save cost ($0.48 vs $0.72).
 */
export async function generateVeo31Video(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  duration: number = 8,
  lastImageUrl?: string,
  negativePrompt: string = "blurry, low quality, watermark, text, UI elements, slow motion, sluggish, nudity, naked, exposed body, extra limbs, body contortion, distorted anatomy",
  aspectRatio: string = "9:16",
): Promise<string> {
  const model = "veo-3-1-i2v";
  // Veo 3.1 valid durations: 4, 6, 8
  const validDurations = [4, 6, 8];
  const clampedDuration = validDurations.reduce((prev, curr) =>
    Math.abs(curr - duration) < Math.abs(prev - duration) ? curr : prev
  );

  console.log(`[Hypereal] Starting Veo 3.1 Fast I2V — ${clampedDuration}s${lastImageUrl ? " (start→end)" : ""}`);
  console.log(`[Hypereal] IMAGE: ${imageUrl.substring(0, 80)}...`);
  if (lastImageUrl) console.log(`[Hypereal] LAST IMAGE: ${lastImageUrl.substring(0, 80)}...`);

  const inputPayload: Record<string, unknown> = {
    prompt,
    image: imageUrl,
    duration: clampedDuration,
    resolution: "1080p",
    aspect_ratio: aspectRatio,
    generate_audio: false, // No audio — saves $0.24 per clip
    negative_prompt: negativePrompt,
  };

  if (lastImageUrl) {
    inputPayload.last_image = lastImageUrl;
  }

  const requestBody = { model, input: inputPayload };
  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Hypereal] Veo 3.1 body (${bodyJson.length} chars): ${truncate(bodyJson)}`);

  const response = await hyperealFetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: bodyJson,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Veo 3.1 API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;
  const pollUrl = data.pollUrl || null;

  console.log(`[Hypereal] Veo 3.1 job created: ${jobId} (credits: ${data.creditsUsed})`);

  if (!jobId) {
    throw new Error(`No jobId from Veo 3.1 — response: ${JSON.stringify(data)}`);
  }

  return pollHyperealJob(jobId, apiKey, model, pollUrl);
}

// ── PixVerse V6 Transitions ───────────────────────────────────────

/**
 * Generate video transition between two images using PixVerse V6.
 *
 * Model: pixverse-v6-transitions (40 credits / $0.40 per transition)
 * Purpose-built for smooth transitions between start and end frames.
 * No duration control — PixVerse determines optimal length.
 * No negative prompt support.
 *
 * API format (from Hypereal docs):
 *   { "model": "pixverse-v6-transitions",
 *     "prompt": "optional short guidance",
 *     "start_image": "url", "end_image": "url" }
 *
 * The prompt field is OPTIONAL and should be kept SHORT.
 * PixVerse V6 is a transition model, not a general I2V model.
 * Long complex prompts cause E1001 generation failures.
 */
export async function generatePixVerseTransition(
  startImageUrl: string,
  endImageUrl: string,
  prompt: string,
  apiKey: string,
): Promise<string> {
  const model = "pixverse-v6-transitions";

  console.log(`[Hypereal] Starting PixVerse V6 Transition`);
  console.log(`[Hypereal] START IMAGE: ${startImageUrl.substring(0, 80)}...`);
  console.log(`[Hypereal] END IMAGE: ${endImageUrl.substring(0, 80)}...`);

  // PixVerse V6 prompt must be SHORT. Long prompts cause E1001 failures.
  // Keep it under 200 chars — this is a transition model, not a general video model.
  const shortPrompt = prompt
    ? prompt.substring(0, 200).replace(/\s+\S*$/, "")
    : "Smooth cinematic transition between the two scenes.";

  // Try nested input format (matching Hypereal general video endpoint structure)
  // Their docs show flat format for PixVerse but the 500 E1001 errors suggest
  // the general endpoint may require the input wrapper for all models.
  const requestBody = {
    model,
    input: {
      prompt: shortPrompt,
      start_image: startImageUrl,
      end_image: endImageUrl,
    },
  };

  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Hypereal] PixVerse V6 body (${bodyJson.length} chars): ${truncate(bodyJson)}`);

  const response = await hyperealFetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: bodyJson,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal PixVerse V6 API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;
  const pollUrl = data.pollUrl || null;

  console.log(`[Hypereal] PixVerse V6 job created: ${jobId} (credits: ${data.creditsUsed})`);

  if (!jobId) {
    throw new Error(`No jobId from PixVerse V6 — response: ${JSON.stringify(data)}`);
  }

  return pollHyperealJob(jobId, apiKey, model, pollUrl);
}

// ── Legacy Seedance export (kept for import compatibility) ─────────

export async function generateVideoFromImage(
  _imageUrl: string,
  _prompt: string,
  _apiKey: string,
): Promise<string> {
  throw new Error(
    "Seedance I2V is not available on Hypereal API. Use Kling or Grok Video I2V instead."
  );
}
