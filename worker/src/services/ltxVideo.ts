/**
 * LTX 2.3 Pro video generation via Replicate.
 *
 * Model: lightricks/ltx-2.3-pro
 * Supports native first frame + last frame interpolation for seamless transitions.
 *
 * Usage:
 *   image (first frame) + last_frame_image (next scene's image) → seamless morph video
 *   Last scene: image only, no last_frame_image
 */

const REPLICATE_API = "https://api.replicate.com/v1/models/lightricks/ltx-2.3-pro/predictions";
const REPLICATE_POLL = "https://api.replicate.com/v1/predictions";

// ── Types ────────────────────────────────────────────────────────────

export type CameraMotion =
  | "none"
  | "dolly_in"
  | "dolly_out"
  | "dolly_left"
  | "dolly_right"
  | "jib_up"
  | "jib_down"
  | "static"
  | "focus_shift";

export interface LtxVideoInput {
  /** Visual/motion prompt describing the scene (max ~2500 chars) */
  prompt: string;
  /** First frame image URL (Scene N's image) */
  imageUrl: string;
  /** Last frame image URL (Scene N+1's image) — creates seamless morph */
  lastFrameImageUrl?: string;
  /** Output format */
  aspectRatio: "16:9" | "9:16";
  /** Video duration: 6, 8, or 10 seconds */
  duration: 6 | 8 | 10;
  /** Camera motion effect */
  cameraMotion: CameraMotion;
}

export interface LtxVideoResult {
  url: string | null;
  provider: string;
  error?: string;
}

// ── Camera Motion Selection ──────────────────────────────────────────

/** Available camera motions (excluding 'none' and 'static') */
const DYNAMIC_MOTIONS: CameraMotion[] = [
  "dolly_in", "dolly_out", "dolly_left", "dolly_right",
  "jib_up", "jib_down", "focus_shift",
];

/**
 * Pick a camera motion for a scene based on its index.
 * Rotates through dynamic motions so adjacent scenes have different movement.
 */
export function pickCameraMotion(sceneIndex: number): CameraMotion {
  return DYNAMIC_MOTIONS[sceneIndex % DYNAMIC_MOTIONS.length];
}

/**
 * Pick the LTX duration that best covers the audio length.
 * LTX accepts: 6, 8, 10.
 */
export function pickLtxDuration(audioSeconds: number): 6 | 8 | 10 {
  if (audioSeconds <= 7) return 6;
  if (audioSeconds <= 9) return 8;
  return 10;
}

// ── Main API ─────────────────────────────────────────────────────────

/**
 * Generate video using Replicate LTX 2.3 Pro.
 */
export async function generateLtxVideo(
  input: LtxVideoInput
): Promise<LtxVideoResult> {
  const apiKey = (process.env.REPLICATE_API_KEY || "").trim();
  if (!apiKey) {
    return { url: null, provider: "LTX 2.3 Pro", error: "REPLICATE_API_KEY not configured" };
  }

  const hasLastFrame = !!input.lastFrameImageUrl;
  console.log(
    `[LTX] Starting LTX 2.3 Pro — ${input.duration}s, ${input.aspectRatio}, ` +
    `camera=${input.cameraMotion}${hasLastFrame ? ", with last_frame_image" : ""}`
  );

  const replicateInput: Record<string, unknown> = {
    task: "image_to_video",
    prompt: input.prompt,
    image: input.imageUrl,
    duration: input.duration,
    aspect_ratio: input.aspectRatio,
    resolution: "1080p",
    fps: 24,
    camera_motion: input.cameraMotion,
    generate_audio: false,
  };

  if (input.lastFrameImageUrl) {
    replicateInput.last_frame_image = input.lastFrameImageUrl;
  }

  try {
    // Create prediction
    const createRes = await fetch(REPLICATE_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Prefer": "wait",
      },
      body: JSON.stringify({ input: replicateInput }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      throw new Error(`Replicate create failed: ${createRes.status} — ${errText.substring(0, 300)}`);
    }

    const prediction = await createRes.json() as any;

    // Check if the "Prefer: wait" header gave us the result directly
    if (prediction.status === "succeeded" && prediction.output) {
      const url = extractOutputUrl(prediction.output);
      if (url) {
        console.log(`[LTX] ✅ Completed immediately`);
        return { url, provider: "LTX 2.3 Pro" };
      }
    }

    const predId = prediction.id;
    if (!predId) {
      throw new Error(`No prediction ID: ${JSON.stringify(prediction).substring(0, 200)}`);
    }

    console.log(`[LTX] Prediction created: ${predId}`);

    // Poll for completion
    const url = await pollPrediction(predId, apiKey);
    if (url) {
      console.log(`[LTX] ✅ Completed: ${url.substring(0, 80)}...`);
      return { url, provider: "LTX 2.3 Pro" };
    }

    return { url: null, provider: "LTX 2.3 Pro", error: "No output URL returned" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[LTX] ❌ Failed: ${msg}`);
    return { url: null, provider: "LTX 2.3 Pro", error: msg };
  }
}

// ── Polling ──────────────────────────────────────────────────────────

async function pollPrediction(predId: string, apiKey: string): Promise<string | null> {
  const maxAttempts = 90;  // 90 × 10s = 15 min
  const pollMs = 10_000;

  for (let i = 1; i <= maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollMs));

    if (i <= 2 || i % 5 === 0) {
      console.log(`[LTX] Polling ${predId} (${i}/${maxAttempts})...`);
    }

    const res = await fetch(`${REPLICATE_POLL}/${predId}`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`[LTX] 429 — backing off 30s`);
        await new Promise(r => setTimeout(r, 30_000));
        continue;
      }
      console.warn(`[LTX] Poll HTTP ${res.status}`);
      continue;
    }

    const data = await res.json() as any;

    if (data.status === "succeeded") {
      return extractOutputUrl(data.output);
    }

    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(`LTX ${data.status}: ${data.error || "unknown"}`);
    }
  }

  throw new Error(`LTX timed out after ${maxAttempts} polls`);
}

function extractOutputUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const o = output as any;
    if (o.url) return o.url;
    if (Array.isArray(o) && o[0]) {
      return typeof o[0] === "string" ? o[0] : o[0]?.url || null;
    }
  }
  return null;
}
