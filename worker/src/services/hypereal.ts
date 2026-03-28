
const HYPEREAL_IMAGE_URL = "https://api.hypereal.cloud/v1/images/generate";
const HYPEREAL_VIDEO_URL = "https://api.hypereal.cloud/v1/videos/generate";
const HYPEREAL_JOB_POLL_URL = "https://api.hypereal.cloud/v1/jobs";

// ── Helpers ────────────────────────────────────────────────────────

/** Sleep with jitter: base ± 25% randomisation */
function sleepWithJitter(baseMs: number): Promise<void> {
  const jitter = baseMs * 0.25 * (Math.random() * 2 - 1); // ±25%
  return new Promise(r => setTimeout(r, Math.max(1000, baseMs + jitter)));
}

/** Calculate backoff delay for 429 responses */
function backoffDelay(consecutive429: number): number {
  // 15s → 30s → 60s, capped at 60s
  return Math.min(15_000 * Math.pow(2, consecutive429), 60_000);
}

// ── Image generation ───────────────────────────────────────────────

export async function generateImage(prompt: string, apiKey: string, aspectRatio = "16:9") {
  console.log(`[Hypereal] Generating image for prompt: ${prompt.substring(0, 50)}...`);
  
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

// ── Seedance I2V ───────────────────────────────────────────────────

export async function generateVideoFromImage(imageUrl: string, prompt: string, apiKey: string) {
  console.log(`[Hypereal] Starting Seedance I2V job...`);

  const response = await fetch(HYPEREAL_VIDEO_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "seedance-1-5-pro",
      image_url: imageUrl,
      prompt: prompt
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hypereal Video API Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as any;
  const jobId = data.jobId;

  if (!jobId) throw new Error("No jobId returned from Hypereal Video API");

  return pollVideoJob(jobId, apiKey, "seedance-1-5-pro");
}

// ── Grok Video I2V ─────────────────────────────────────────────────

/**
 * Generate video using Hypereal Grok Video I2V (xAI Grok Imagine Video)
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
  console.log(`[Hypereal] Grok image URL: ${imageUrl.substring(0, 80)}...`);

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

  console.log(`[Hypereal] Grok job created: ${jobId}`);

  if (!jobId) {
    throw new Error(`No jobId from Hypereal Grok — response: ${JSON.stringify(data)}`);
  }

  return pollVideoJob(jobId, apiKey, "grok-video-i2v");
}

// ── Unified poll with rate-limit backoff ───────────────────────────

async function pollVideoJob(
  jobId: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const label = model.includes("grok") ? "Grok" : "Seedance";
  const maxAttempts = 40;          // max poll iterations
  const basePollMs = 15_000;       // 15s between polls (not 5s)
  let consecutive429 = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // On 429 backoff, wait longer; otherwise normal poll interval with jitter
    if (consecutive429 > 0) {
      const delay = backoffDelay(consecutive429);
      console.log(`[Hypereal] ${label} job ${jobId} — 429 backoff ${Math.round(delay / 1000)}s (streak: ${consecutive429})`);
      await sleepWithJitter(delay);
    } else {
      await sleepWithJitter(basePollMs);
    }

    if (attempt % 5 === 0 || attempt <= 2) {
      console.log(`[Hypereal] Polling ${label} job ${jobId} (${attempt}/${maxAttempts})...`);
    }

    const response = await fetch(
      `${HYPEREAL_JOB_POLL_URL}/${jobId}?model=${model}&type=video`,
      { headers: { "Authorization": `Bearer ${apiKey}` } }
    );

    if (response.status === 429) {
      consecutive429++;
      continue;
    }

    if (!response.ok) {
      console.warn(`[Hypereal] ${label} poll ${jobId} — HTTP ${response.status}`);
      consecutive429 = 0;
      continue;
    }

    // Successful response — reset 429 counter
    consecutive429 = 0;

    const data = await response.json() as any;

    if (attempt % 10 === 0) {
      console.log(`[Hypereal] ${label} job ${jobId} status: ${data.status} (attempt ${attempt})`);
    }

    if (data.status === "succeeded") {
      const url = data.outputUrl || data.output_url || data.result?.url;
      console.log(`[Hypereal] ✅ ${label} Video Complete — ${String(url).substring(0, 80)}...`);
      if (!url) {
        throw new Error(`${label} job succeeded but no URL: ${JSON.stringify(data)}`);
      }
      return url;
    }

    if (data.status === "failed") {
      throw new Error(`Hypereal ${label} Job Failed: ${data.error || JSON.stringify(data)}`);
    }

    // "processing" / "starting" — loop again
  }

  throw new Error(`Hypereal ${label} Job timed out after ${maxAttempts} polls (~${Math.round(maxAttempts * basePollMs / 60_000)} min).`);
}
