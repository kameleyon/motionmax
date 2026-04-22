/**
 * Lip-sync service (Hypereal video/lipsync).
 *
 * Takes a generated scene video + the scene's narration audio and returns
 * a new video URL where the character's mouth is aligned to the audio.
 *
 * The Hypereal lip-sync endpoint expects:
 *   POST https://api.hypereal.cloud/v1/videos/generate
 *   { model: "<lipsync-model>", input: { video_url, audio_url, strength } }
 *
 * NOTE: as of wiring this up, the exact model ID + param names for
 * Hypereal's lip-sync task have not been confirmed end-to-end in prod.
 * This service is structured so that when the user confirms the model
 * name (commonly "latent-sync" or "wav2lip-hypereal"), it's a one-line
 * change. Until then, if the env var `HYPEREAL_LIPSYNC_MODEL` is not
 * set, this service performs a safe PASS-THROUGH: logs that lip-sync
 * would have fired, and returns the original video URL unchanged.
 *
 * Callers must treat failure as non-fatal — lip-sync is additive.
 */

const HYPEREAL_VIDEO_URL = "https://api.hypereal.cloud/v1/videos/generate";

const log = {
  info: (...args: unknown[]) => console.log("[LipSync]", ...args),
  warn: (...args: unknown[]) => console.warn("[LipSync]", ...args),
};

export interface LipSyncParams {
  /** URL of the generated scene video (Kling output). */
  videoUrl: string;
  /** URL of the narration audio for this scene. */
  audioUrl: string;
  /** 0–100 strength: <40 subtle, 40–69 natural, 70+ exaggerated.
   *  Translated to a 0..1 float before sending. */
  strength: number;
  /** Hypereal API key. */
  apiKey: string;
  /** Optional override — the env var name if you want to point at a
   *  specific model (e.g. "latent-sync"). Without this and without
   *  HYPEREAL_LIPSYNC_MODEL in env, this service pass-throughs. */
  model?: string;
}

export interface LipSyncResult {
  videoUrl: string;
  applied: boolean;
  reason?: string;
}

function lipSyncModel(override?: string): string | null {
  return (override || process.env.HYPEREAL_LIPSYNC_MODEL || "").trim() || null;
}

export function lipSyncIsConfigured(): boolean {
  return !!lipSyncModel();
}

/** Safe lip-sync: if the model isn't configured, returns the original
 *  video URL + `applied: false` so handlers can log and move on. */
export async function applyLipSync(params: LipSyncParams): Promise<LipSyncResult> {
  const model = lipSyncModel(params.model);
  if (!model) {
    log.warn("[LipSync] No HYPEREAL_LIPSYNC_MODEL configured — skipping (pass-through)");
    return {
      videoUrl: params.videoUrl,
      applied: false,
      reason: "HYPEREAL_LIPSYNC_MODEL not set; this scene kept its original video.",
    };
  }
  if (!params.apiKey) {
    return { videoUrl: params.videoUrl, applied: false, reason: "missing HYPEREAL_API_KEY" };
  }

  const strengthFloat = Math.max(0, Math.min(1, params.strength / 100));
  log.info(`[LipSync] model=${model}, strength=${strengthFloat.toFixed(2)}`);

  try {
    const response = await fetch(HYPEREAL_VIDEO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: {
          video_url: params.videoUrl,
          audio_url: params.audioUrl,
          strength: strengthFloat,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        videoUrl: params.videoUrl,
        applied: false,
        reason: `lip-sync endpoint ${response.status}: ${body.slice(0, 200)}`,
      };
    }

    const json = await response.json() as {
      success?: boolean;
      url?: string;
      video_url?: string;
      data?: { url?: string; video_url?: string };
      output?: { url?: string; video_url?: string };
    };

    const url =
      json.url ??
      json.video_url ??
      json.data?.url ??
      json.data?.video_url ??
      json.output?.url ??
      json.output?.video_url;

    if (!url || typeof url !== "string") {
      return {
        videoUrl: params.videoUrl,
        applied: false,
        reason: `lip-sync response missing URL: ${JSON.stringify(json).slice(0, 200)}`,
      };
    }

    return { videoUrl: url, applied: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { videoUrl: params.videoUrl, applied: false, reason: msg };
  }
}
