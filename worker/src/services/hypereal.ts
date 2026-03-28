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

// ── Grok Video I2V (primary and only video model) ──────────────────

/**
 * Generate video using Hypereal Grok Video I2V (xAI Grok Imagine Video).
 * Returns the video URL on success.
 */
export async function generateGrokVideo(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  aspectRatio: "16:9" | "9:16" = "16:9",
  duration: 10 | 15 = 10,
  resolution: "720P" | "1080P" = "1080P"
) {
  console.log(`[Hypereal] Starting Grok Video I2V — ${duration}s, ${aspectRatio}, ${resolution}`);

  const response = await fetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "grok-video-i2v",
      prompt,
      image_url: imageUrl,
      duration,
      aspect_ratio: aspectRatio,
      resolution
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Grok Video API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;
  // Use the API-provided poll URL if available, otherwise construct one
  const pollUrl = data.pollUrl || null;

  console.log(`[Hypereal] Grok job created: ${jobId} (credits: ${data.creditsUsed})`);

  if (!jobId) {
    throw new Error(`No jobId from Hypereal Grok — response: ${JSON.stringify(data)}`);
  }

  return pollGrokJob(jobId, apiKey, pollUrl);
}

// ── Poll with rate-limit backoff ───────────────────────────────────

async function pollGrokJob(
  jobId: string,
  apiKey: string,
  pollUrl: string | null,
): Promise<string> {
  const maxAttempts = 40;
  const basePollMs = 20_000;    // 20s between polls
  const max429Streak = 4;       // bail after 4 consecutive 429s → fall to Replicate
  let consecutive429 = 0;

  // Use the API-returned poll URL, or construct a fallback
  const url = pollUrl
    || `https://api.hypereal.cloud/v1/jobs/${jobId}?model=grok-video-i2v&type=video`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // On 429 streak, use exponential backoff; otherwise staggered base interval
    if (consecutive429 > 0) {
      const delay = backoffDelay(consecutive429);
      if (consecutive429 <= 3 || consecutive429 % 5 === 0) {
        console.log(`[Hypereal] Grok ${jobId} — 429 backoff ${Math.round(delay / 1000)}s (streak: ${consecutive429})`);
      }
      await sleepWithJitter(delay);
    } else {
      await sleepWithJitter(basePollMs);
    }

    // Log sparingly to reduce noise
    if (attempt <= 2 || attempt % 5 === 0) {
      console.log(`[Hypereal] Polling Grok ${jobId} (${attempt}/${maxAttempts})...`);
    }

    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });

    if (response.status === 429) {
      consecutive429++;
      if (consecutive429 >= max429Streak) {
        console.warn(`[Hypereal] Grok ${jobId} — ${max429Streak} consecutive 429s, bailing to fallback`);
        throw new Error(`Hypereal rate-limited: ${max429Streak} consecutive 429 responses`);
      }
      continue;
    }

    if (!response.ok) {
      console.warn(`[Hypereal] Grok poll ${jobId} — HTTP ${response.status}`);
      consecutive429 = 0;
      continue;
    }

    // Success response — reset streak
    consecutive429 = 0;
    const data = await response.json() as any;

    if (data.status === "succeeded") {
      const videoUrl = data.outputUrl || data.output_url || data.result?.url;
      console.log(`[Hypereal] ✅ Grok complete ${jobId} — ${String(videoUrl).substring(0, 80)}...`);
      if (!videoUrl) {
        throw new Error(`Grok job succeeded but no URL: ${JSON.stringify(data)}`);
      }
      return videoUrl;
    }

    if (data.status === "failed") {
      throw new Error(`Grok Job Failed: ${data.error || JSON.stringify(data)}`);
    }

    // "processing" / "starting" — continue polling
    if (attempt % 10 === 0) {
      console.log(`[Hypereal] Grok ${jobId} status: ${data.status} (attempt ${attempt})`);
    }
  }

  throw new Error(`Grok Video timed out after ${maxAttempts} polls (~${Math.round(maxAttempts * basePollMs / 60_000)} min).`);
}

// ── Legacy Seedance export (kept for import compatibility) ─────────
// Seedance models are NOT available on Hypereal API.
// This will throw immediately with a clear message.

export async function generateVideoFromImage(
  _imageUrl: string,
  _prompt: string,
  _apiKey: string,
): Promise<string> {
  throw new Error(
    "Seedance I2V is not available on Hypereal API. Use Grok Video I2V instead."
  );
}
