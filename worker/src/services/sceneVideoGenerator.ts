/**
 * AI-powered scene video generation for export enhancement.
 *
 * Generates short (3-10s) video clips from still images using AI video models,
 * replacing static Ken Burns with genuine camera motion and scene dynamics.
 *
 * Provider chain:
 *   1. Hypereal Grok Video I2V (primary — 1080P, up to 10s)
 *   2. Replicate xai/grok-imagine-video (fallback — 720p)
 *
 * Usage during export:
 *   - Called per-scene when EXPORT_AI_VIDEO=true
 *   - Returns a video URL or null (caller falls back to Ken Burns)
 *   - Respects per-scene timeout to prevent export stalls
 *
 * This is separate from handleCinematicVideo.ts which is used during
 * the cinematic generation pipeline (pre-export). This service is used
 * during the export phase itself as an optional enhancement.
 */
import { generateGrokVideo, type GrokVideoInput, type GrokVideoResult } from "./grokVideo.js";
import { writeApiLog } from "../lib/logger.js";

// ── Types ────────────────────────────────────────────────────────────

export interface SceneVideoRequest {
  /** Scene index (for logging) */
  sceneIndex: number;
  /** Image URL to animate (I2V start frame) */
  imageUrl: string;
  /** Image URL for the target end state (for morphing transitions) */
  endImageUrl?: string;
  /** Visual prompt describing the scene */
  prompt: string;
  /** Output format: landscape, portrait, square */
  format: string;
  /** Desired video duration in seconds (default 5) */
  duration?: number;
  /** Project ID (for logging) */
  projectId?: string;
  /** User ID (for logging) */
  userId?: string;
}

export interface SceneVideoResult {
  /** Video URL if generation succeeded, null if failed */
  url: string | null;
  /** Which provider generated the video */
  provider: string;
  /** Duration of the generated video in seconds */
  durationSeconds: number;
  /** Error message if generation failed */
  error?: string;
}

// ── Video Prompt Engineering ─────────────────────────────────────────

/**
 * Build a video-optimized prompt from the scene's visual prompt.
 * Emphasizes camera motion and scene dynamics over character lip-sync.
 */
function buildVideoPrompt(visualPrompt: string): string {
  return `${visualPrompt}

Cinematic motion: steady camera movement at natural pace, subtle parallax, atmospheric dynamics.
Focus on camera motion (dolly, pan, tilt) and environmental motion (wind, particles, light shifts).
Maintain stable composition. No rapid cuts or jarring transitions.`;
}

// ── Main API ─────────────────────────────────────────────────────────

/**
 * Generate an AI video clip for a single scene.
 *
 * Attempts Hypereal Grok → Replicate Grok fallback chain.
 * Returns null URL on failure (caller should fall back to Ken Burns).
 *
 * @param request  Scene video generation request
 * @param timeoutMs  Maximum time to wait for video generation (default 5 min)
 */
export async function generateSceneVideo(
  request: SceneVideoRequest,
  timeoutMs: number = 5 * 60 * 1000
): Promise<SceneVideoResult> {
  const {
    sceneIndex,
    imageUrl,
    endImageUrl,
    prompt,
    format,
    duration = 5,
    projectId,
    userId,
  } = request;

  const startTime = Date.now();
  const isTransition = !!endImageUrl;
  // Transitions use the raw morphing prompt — do NOT append scene video boilerplate
  const videoPrompt = isTransition ? prompt : buildVideoPrompt(prompt);
  const mode = isTransition ? "transition (start→end)" : "scene";

  console.log(
    `[SceneVideoGen] Scene ${sceneIndex}: generating ${duration}s AI video — ${mode} (${format})`
  );

  try {
    // Wrap the entire generation in a timeout
    const result = await Promise.race<GrokVideoResult>([
      generateGrokVideo({
        prompt: videoPrompt,
        imageUrl,
        endImageUrl,
        format,
        duration,
      }),
      new Promise<GrokVideoResult>((_, reject) =>
        setTimeout(
          () => reject(new Error(`AI video generation timed out after ${timeoutMs / 1000}s`)),
          timeoutMs
        )
      ),
    ]);

    const elapsed = Date.now() - startTime;

    if (result.url) {
      console.log(
        `[SceneVideoGen] Scene ${sceneIndex}: ✅ ${result.provider} succeeded in ${(elapsed / 1000).toFixed(1)}s`
      );

      // Log the API call
      await writeApiLog({
        userId,
        projectId,
        provider: "hypereal",
        model: "grok-video-i2v",
        status: "success",
        durationMs: elapsed,
        cost: 0.05, // estimated cost per video generation
        requestDetails: { sceneIndex, format, duration },
      }).catch(() => {}); // non-critical

      return {
        url: result.url,
        provider: result.provider,
        durationSeconds: duration,
      };
    }

    // Provider returned no URL
    console.warn(
      `[SceneVideoGen] Scene ${sceneIndex}: ❌ No URL returned — ${result.error}`
    );

    return {
      url: null,
      provider: result.provider,
      durationSeconds: 0,
      error: result.error || "No video URL returned",
    };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    console.error(
      `[SceneVideoGen] Scene ${sceneIndex}: ❌ Failed after ${(elapsed / 1000).toFixed(1)}s — ${errorMsg}`
    );

    await writeApiLog({
      userId,
      projectId,
      provider: "hypereal",
      model: "grok-video-i2v",
      status: "error",
      durationMs: elapsed,
      cost: 0,
      error: errorMsg,
    }).catch(() => {});

    return {
      url: null,
      provider: "Grok Video",
      durationSeconds: 0,
      error: errorMsg,
    };
  }
}

/**
 * Check whether AI video generation is available (API keys configured).
 */
export function isAiVideoAvailable(): boolean {
  const hyperealKey = (process.env.HYPEREAL_API_KEY || "").trim();
  const replicateKey = (process.env.REPLICATE_API_KEY || "").trim();
  return hyperealKey.length > 0 || replicateKey.length > 0;
}
