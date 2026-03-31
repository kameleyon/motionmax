/**
 * Veo 3.1 Fast I2V video generation via Hypereal.
 *
 * Model: veo-3-1-i2v (72 credits)
 * Google Veo 3.1 Fast image-to-video with native first + last frame interpolation.
 *
 * Defaults: duration=8, resolution=1080p, generate_audio=false
 * Variable: aspect_ratio (16:9 or 9:16)
 * Negative prompt: slow, slow motion (enforced)
 */

const HYPEREAL_VIDEO_URL = "https://api.hypereal.cloud/v1/videos/generate";

// ── Types ────────────────────────────────────────────────────────────

export interface VeoVideoInput {
  /** Visual/motion prompt */
  prompt: string;
  /** First frame image URL (Scene N's image) */
  imageUrl: string;
  /** Last frame image URL (Scene N+1's image) — creates seamless morph */
  lastImageUrl?: string;
  /** Output aspect ratio */
  aspectRatio: "16:9" | "9:16";
}

export interface VeoVideoResult {
  url: string | null;
  provider: string;
  error?: string;
}

// ── Main API ─────────────────────────────────────────────────────────

export async function generateVeoVideo(
  input: VeoVideoInput
): Promise<VeoVideoResult> {
  const apiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  if (!apiKey) {
    return { url: null, provider: "Veo 3.1", error: "HYPEREAL_API_KEY not configured" };
  }

  const hasLastImage = !!input.lastImageUrl;
  console.log(
    `[Veo] Starting Veo 3.1 Fast I2V — 8s, ${input.aspectRatio}${hasLastImage ? ", with last_image" : ""}`
  );

  const veoInput: Record<string, unknown> = {
    prompt: input.prompt,
    image: input.imageUrl,
    duration: 8,
    resolution: "1080p",
    aspect_ratio: input.aspectRatio,
    generate_audio: false,
    negative_prompt: "slow, slow motion, slow mo, sluggish, lethargic, frozen, static, still, motionless",
  };

  if (input.lastImageUrl) {
    veoInput.last_image = input.lastImageUrl;
  }

  const requestBody = { model: "veo-3-1-i2v", input: veoInput };
  const bodyJson = JSON.stringify(requestBody);
  console.log(`[Veo] Body (${bodyJson.length} chars): ${bodyJson.substring(0, 1500)}`);

  try {
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
      throw new Error(`Veo API Error: ${response.status} - ${errorText.substring(0, 300)}`);
    }

    const data = await response.json() as any;
    const jobId = data.jobId;
    const pollUrl = data.pollUrl || null;

    console.log(`[Veo] Job created: ${jobId} (credits: ${data.creditsUsed})`);

    if (!jobId) {
      throw new Error(`No jobId from Veo: ${JSON.stringify(data).substring(0, 200)}`);
    }

    const videoUrl = await pollVeoJob(jobId, apiKey, pollUrl);
    console.log(`[Veo] ✅ Completed: ${videoUrl.substring(0, 80)}...`);
    return { url: videoUrl, provider: "Veo 3.1" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Veo] ❌ Failed: ${msg}`);
    return { url: null, provider: "Veo 3.1", error: msg };
  }
}

// ── Polling ──────────────────────────────────────────────────────────

function sleepWithJitter(baseMs: number): Promise<void> {
  const jitter = baseMs * 0.25 * (Math.random() * 2 - 1);
  return new Promise(r => setTimeout(r, Math.max(2000, baseMs + jitter)));
}

async function pollVeoJob(
  jobId: string,
  apiKey: string,
  pollUrl: string | null,
): Promise<string> {
  const maxAttempts = 60;
  const basePollMs = 15_000;
  let consecutive429 = 0;

  const url = pollUrl
    || `https://api.hypereal.cloud/v1/jobs/${jobId}?model=veo-3-1-i2v&type=video`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (consecutive429 > 0) {
      const delay = Math.min(30_000 * Math.pow(2, consecutive429), 120_000);
      await sleepWithJitter(delay);
    } else {
      await sleepWithJitter(basePollMs);
    }

    if (attempt <= 2 || attempt % 5 === 0) {
      console.log(`[Veo] Polling ${jobId} (${attempt}/${maxAttempts})...`);
    }

    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (response.status === 429) {
      consecutive429++;
      if (consecutive429 >= 4) throw new Error(`Veo rate-limited: 4 consecutive 429s`);
      continue;
    }

    if (!response.ok) {
      console.warn(`[Veo] Poll HTTP ${response.status}`);
      consecutive429 = 0;
      continue;
    }

    consecutive429 = 0;
    const data = await response.json() as any;

    if (data.status === "succeeded" || data.status === "completed") {
      const videoUrl = data.outputUrl || data.output_url || data.result?.url || data.output?.url || data.url;
      if (!videoUrl) {
        console.log(`[Veo] Full response: ${JSON.stringify(data)}`);
        throw new Error(`Veo completed but no URL found`);
      }
      return videoUrl;
    }

    if (data.status === "failed" || data.status === "error") {
      throw new Error(`Veo failed: ${data.error || JSON.stringify(data)}`);
    }
  }

  throw new Error(`Veo timed out after ${maxAttempts} polls`);
}
