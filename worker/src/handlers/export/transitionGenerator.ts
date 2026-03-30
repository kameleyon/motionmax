/**
 * AI-powered seamless scene transition generator.
 *
 * Uses Kling V3.0 (primary) or Kling V2.6 (fallback) on Hypereal to generate
 * continuous fly-through morph transitions between scenes.
 *
 * Both Kling models natively support `image` (start frame) + `end_image` (end frame),
 * generating video that interpolates seamlessly between the two visual states.
 *
 * Flow per transition:
 *   1. Extract last frame of Scene N → upload as `image`
 *   2. Extract first frame of Scene N+1 → upload as `end_image`
 *   3. Build prompt from Scene N+1's video motion prompt + camera motion
 *   4. Kling generates a 10s video morphing from start to end frame
 *   5. Normalize and insert between scene clips
 *
 * Provider chain:
 *   Primary:  Kling V3.0 Std I2V (kling-3-0-std-i2v) — 42 credits
 *   Fallback: Kling V2.6 Pro I2V (kling-2-6-i2v-pro) — 35 credits
 *   // Grok Video I2V — commented out (does not support end_image properly)
 */
import path from "path";
import fs from "fs";
import { runFfmpeg } from "./ffmpegCmd.js";
import { removeFiles } from "./storageHelpers.js";
import {
  generateKlingV3Video,
  generateKlingV26Video,
  // generateGrokVideo — commented out: Grok does not support end_image natively
} from "../../services/hypereal.js";
import { supabase } from "../../lib/supabase.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TransitionRequest {
  /** Index of the "from" scene */
  fromSceneIndex: number;
  /** Path to the "from" scene MP4 */
  fromClipPath: string;
  /** Path to the "to" scene MP4 */
  toClipPath: string;
  /** Visual prompt of the outgoing scene (Scene N) */
  fromScenePrompt?: string;
  /** Visual prompt of the incoming scene (Scene N+1) — used for morphing target */
  toScenePrompt?: string;
  /** Video motion prompt for Scene N+1 (how the destination scene moves) */
  toVideoMotionPrompt?: string;
  /** Output path for the transition clip */
  outputPath: string;
  /** Temp directory for intermediate files */
  tempDir: string;
  /** Output format (landscape, portrait, square) */
  format: string;
  /** Target width */
  width: number;
  /** Target height */
  height: number;
  /** Transition duration in seconds (default 10) */
  duration?: number;
  /** Project ID for logging */
  projectId?: string;
  /** User ID for logging */
  userId?: string;
  /** Timeout in ms (default 5 min) */
  timeoutMs?: number;
}

export interface TransitionResult {
  /** Path to the generated transition clip, or null on failure */
  path: string | null;
  /** Whether AI generation was used */
  aiGenerated: boolean;
  /** Duration of the transition in seconds */
  durationSeconds: number;
  /** Provider that generated the transition */
  provider?: string;
  /** Error message if generation failed */
  error?: string;
}

// ── Frame Extraction ─────────────────────────────────────────────────

async function extractLastFrame(
  videoPath: string,
  outputPath: string,
  width: number,
  height: number
): Promise<void> {
  await runFfmpeg([
    "-sseof", "-0.1",
    "-i", videoPath,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "-frames:v", "1",
    "-q:v", "2",
    outputPath,
  ], 30_000);
}

async function extractFirstFrame(
  videoPath: string,
  outputPath: string,
  width: number,
  height: number
): Promise<void> {
  await runFfmpeg([
    "-i", videoPath,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "-frames:v", "1",
    "-q:v", "2",
    outputPath,
  ], 30_000);
}

async function uploadFrameForAi(
  localPath: string,
  projectId: string,
  label: string
): Promise<string> {
  const fileBuffer = await fs.promises.readFile(localPath);
  const fileName = `transitions/${projectId}/${label}_${Date.now()}.png`;

  const { error } = await supabase.storage
    .from("scene-videos")
    .upload(fileName, fileBuffer, {
      contentType: "image/png",
      upsert: true,
    });

  if (error) throw new Error(`Frame upload failed: ${error.message}`);

  const { data } = supabase.storage.from("scene-videos").getPublicUrl(fileName);
  return data.publicUrl;
}

// ── Transition Prompt Builder ────────────────────────────────────────

/**
 * Build the transition prompt from the destination scene's context.
 *
 * The prompt describes:
 *   - The camera motion (continuous fly-through)
 *   - The morphing from Scene N into Scene N+1
 *   - Scene N+1's own video motion (what happens when we arrive)
 *
 * The AI receives:
 *   - `image`: Scene N's last frame (start state)
 *   - `end_image`: Scene N+1's first frame (end state)
 *   - `prompt`: HOW to get from start to end
 */
function buildTransitionPrompt(
  fromPrompt: string | undefined,
  toPrompt: string | undefined,
  toVideoMotion: string | undefined,
  duration: number
): string {
  const fromDesc = fromPrompt ? fromPrompt.substring(0, 150) : "the current scene";
  const toDesc = toPrompt ? toPrompt.substring(0, 150) : "the next scene";

  // Start with the fly-through morph instruction
  let prompt =
    `A continuous, single-take fly-through shot over ${duration} seconds. ` +
    `The camera is in constant dynamic motion, panning and moving forward. ` +
    `The shot begins on the provided starting frame showing ${fromDesc}, ` +
    `then the camera fluidly pushes past the foreground as the environment ` +
    `seamlessly morphs, stretches, and melts directly into the provided ending frame showing ${toDesc}. ` +
    `There are no hard cuts, only continuous forward camera movement with seamless, fluid object morphing bridging the two visual states.`;

  // Append Scene N+1's video motion if available — tells the AI how the
  // destination scene should be moving when we arrive
  if (toVideoMotion) {
    prompt += ` As the transition completes, ${toVideoMotion.substring(0, 200)}.`;
  }

  return prompt;
}

// ── Main API ─────────────────────────────────────────────────────────

export async function generateTransitionVideo(
  request: TransitionRequest
): Promise<TransitionResult> {
  const {
    fromSceneIndex,
    fromClipPath,
    toClipPath,
    fromScenePrompt,
    toScenePrompt,
    toVideoMotionPrompt,
    outputPath,
    tempDir,
    format,
    width,
    height,
    duration = 10,
    projectId = "unknown",
    userId,
    timeoutMs = 5 * 60 * 1000,
  } = request;

  const label = `${fromSceneIndex}→${fromSceneIndex + 1}`;
  const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();

  if (!hyperealApiKey) {
    return { path: null, aiGenerated: false, durationSeconds: 0, error: "HYPEREAL_API_KEY not configured" };
  }

  console.log(`[TransitionGen] ${label}: generating ${duration}s Kling transition...`);

  const lastFramePath = path.join(tempDir, `trans_${fromSceneIndex}_lastframe.png`);
  const firstFramePath = path.join(tempDir, `trans_${fromSceneIndex}_firstframe.png`);

  try {
    // 1. Extract BOTH frames
    await Promise.all([
      extractLastFrame(fromClipPath, lastFramePath, width, height),
      extractFirstFrame(toClipPath, firstFramePath, width, height),
    ]);

    // 2. Upload BOTH frames for API access
    const [startFrameUrl, endFrameUrl] = await Promise.all([
      uploadFrameForAi(lastFramePath, projectId, `trans_${fromSceneIndex}_start`),
      uploadFrameForAi(firstFramePath, projectId, `trans_${fromSceneIndex}_end`),
    ]);

    console.log(`[TransitionGen] ${label}: both frames uploaded`);

    // 3. Build contextual prompt
    const transitionPrompt = buildTransitionPrompt(
      fromScenePrompt,
      toScenePrompt,
      toVideoMotionPrompt,
      duration
    );

    // 4. Generate transition — Kling V2.6 Pro primary, Kling V3.0 fallback
    let videoUrl: string | null = null;
    let provider = "";

    // Kling V2.6 only supports 5 or 10
    const v26Duration = duration <= 7 ? 5 : 10;

    // ── Primary: Kling V2.6 Pro I2V (strong detail preservation, 35 credits) ──
    try {
      console.log(`[TransitionGen] ${label}: trying Kling V2.6 Pro (${v26Duration}s)...`);
      videoUrl = await Promise.race<string>([
        generateKlingV26Video(
          startFrameUrl,
          transitionPrompt,
          hyperealApiKey,
          v26Duration,
          endFrameUrl
        ),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Kling V2.6 Pro timed out")), timeoutMs)
        ),
      ]);
      provider = "Kling V2.6 Pro";
      console.log(`[TransitionGen] ${label}: ✅ Kling V2.6 Pro succeeded`);
    } catch (err) {
      console.warn(`[TransitionGen] ${label}: ❌ Kling V2.6 Pro failed — ${(err as Error).message}`);
    }

    // ── Fallback: Kling V3.0 Std I2V (supports 3-15s) ──
    if (!videoUrl) {
      try {
        console.log(`[TransitionGen] ${label}: trying Kling V3.0 fallback (${duration}s)...`);
        videoUrl = await Promise.race<string>([
          generateKlingV3Video(
            startFrameUrl,
            transitionPrompt,
            hyperealApiKey,
            duration,
            endFrameUrl
          ),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("Kling V3.0 timed out")), timeoutMs)
          ),
        ]);
        provider = "Kling V3.0";
        console.log(`[TransitionGen] ${label}: ✅ Kling V3.0 succeeded`);
      } catch (err) {
        console.warn(`[TransitionGen] ${label}: ❌ Kling V3.0 failed — ${(err as Error).message}`);
        return {
          path: null,
          aiGenerated: false,
          durationSeconds: 0,
          error: `Both Kling V2.6 Pro and V3.0 failed for transition ${label}`,
        };
      }
    }

    // ── Grok Video I2V — commented out: does not support end_image properly
    // if (!videoUrl) {
    //   try {
    //     videoUrl = await generateGrokVideo(startFrameUrl, transitionPrompt, hyperealApiKey, ...);
    //     provider = "Grok";
    //   } catch (err) { ... }
    // }

    // 5. Download and normalize the transition video
    const rawTransPath = path.join(tempDir, `trans_${fromSceneIndex}_raw.mp4`);
    const dlResponse = await fetch(videoUrl);
    if (!dlResponse.ok) throw new Error(`Download failed: ${dlResponse.status}`);
    const buffer = Buffer.from(await dlResponse.arrayBuffer());
    await fs.promises.writeFile(rawTransPath, buffer);

    // Normalize to target resolution + add silent audio
    await runFfmpeg([
      "-i", rawTransPath,
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest",
      "-movflags", "+faststart",
      "-threads", "2",
      outputPath,
    ]);

    removeFiles(rawTransPath);
    console.log(`[TransitionGen] ${label}: ✅ transition complete (${provider})`);

    return { path: outputPath, aiGenerated: true, durationSeconds: duration, provider };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TransitionGen] ${label}: ❌ Failed — ${errorMsg}`);
    return { path: null, aiGenerated: false, durationSeconds: 0, error: errorMsg };
  } finally {
    removeFiles(lastFramePath, firstFramePath);
  }
}

/**
 * Generate transitions for all adjacent scene pairs.
 * Returns one TransitionResult per junction (length = clipCount - 1).
 */
export async function generateAllTransitions(
  clipPaths: string[],
  scenes: any[],
  tempDir: string,
  config: {
    format: string;
    width: number;
    height: number;
    duration?: number;
    projectId?: string;
    userId?: string;
    timeoutMs?: number;
  }
): Promise<TransitionResult[]> {
  if (clipPaths.length < 2) return [];

  const results: TransitionResult[] = [];

  for (let i = 0; i < clipPaths.length - 1; i++) {
    const outputPath = path.join(tempDir, `transition_${i}_${i + 1}.mp4`);

    const fromScene = scenes[i];
    const toScene = scenes[i + 1];

    // Scene visual prompts (what the image looks like)
    const fromPrompt = fromScene?.visualPrompt || fromScene?.visual_prompt;
    const toPrompt = toScene?.visualPrompt || toScene?.visual_prompt;

    // Scene video motion prompt (how the scene animates — from the script)
    const toVideoMotion = toScene?.videoPrompt || toScene?.video_prompt || toScene?.voiceover;

    const result = await generateTransitionVideo({
      fromSceneIndex: i,
      fromClipPath: clipPaths[i],
      toClipPath: clipPaths[i + 1],
      fromScenePrompt: fromPrompt,
      toScenePrompt: toPrompt,
      toVideoMotionPrompt: toVideoMotion,
      outputPath,
      tempDir,
      format: config.format,
      width: config.width,
      height: config.height,
      duration: config.duration || 10,
      projectId: config.projectId,
      userId: config.userId,
      timeoutMs: config.timeoutMs,
    });

    results.push(result);
  }

  const aiCount = results.filter((r) => r.aiGenerated).length;
  const providers = results.filter((r) => r.provider).map((r) => r.provider);
  console.log(
    `[TransitionGen] ${aiCount}/${results.length} transitions generated — providers: ${[...new Set(providers)].join(", ") || "none"}`
  );

  return results;
}
