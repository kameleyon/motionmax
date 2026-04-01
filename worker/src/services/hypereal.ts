const HYPEREAL_IMAGE_URL = "https://api.hypereal.cloud/v1/images/generate";
const HYPEREAL_VIDEO_URL = "https://api.hypereal.cloud/v1/videos/generate";

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

// ── Image generation ───────────────────────────────────────────────

export async function generateImage(prompt: string, apiKey: string, aspectRatio = "16:9") {
  console.log(`[Hypereal] Generating image: ${prompt.substring(0, 50)}...`);

  const response = await fetch(HYPEREAL_IMAGE_URL, {
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
  console.log(`[Hypereal] FULL BODY (${bodyJson.length} chars): ${bodyJson.substring(0, 2000)}`);

  const response = await fetch(HYPEREAL_VIDEO_URL, {
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
  console.log(`[Hypereal] Kling V3 body (${bodyJson.length} chars): ${bodyJson.substring(0, 2000)}`);

  const response = await fetch(HYPEREAL_VIDEO_URL, {
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
    sound: false, // must be false when using end_image
  };

  if (endImageUrl) {
    inputPayload.end_image = endImageUrl;
  }

  const requestBody = { model, input: inputPayload };
  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Hypereal] Kling V2.6 body (${bodyJson.length} chars): ${bodyJson.substring(0, 2000)}`);

  const response = await fetch(HYPEREAL_VIDEO_URL, {
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
  const maxAttempts = 40;
  const basePollMs = 20_000;    // 20s between polls
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
      await sleepWithJitter(basePollMs);
    }

    if (attempt <= 2 || attempt % 5 === 0) {
      console.log(`[Hypereal] Polling ${model} ${jobId} (${attempt}/${maxAttempts})...`);
    }

    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });

    if (response.status === 429) {
      consecutive429++;
      if (consecutive429 >= max429Streak) {
        console.warn(`[Hypereal] ${model} ${jobId} — ${max429Streak} consecutive 429s, bailing`);
        throw new Error(`Hypereal rate-limited: ${max429Streak} consecutive 429 responses`);
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
        throw new Error(`${model} job ${data.status} but no URL found in response`);
      }
      return videoUrl;
    }

    if (data.status === "failed" || data.status === "error") {
      throw new Error(`${model} job failed: ${data.error || JSON.stringify(data)}`);
    }

    if (attempt % 10 === 0) {
      console.log(`[Hypereal] ${model} ${jobId} status: ${data.status} (attempt ${attempt})`);
    }
  }

  throw new Error(`${model} timed out after ${maxAttempts} polls (~${Math.round(maxAttempts * basePollMs / 60_000)} min).`);
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
  console.log(`[Hypereal] Kling V2.5 body (${bodyJson.length} chars): ${bodyJson.substring(0, 2000)}`);

  const response = await fetch(HYPEREAL_VIDEO_URL, {
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
