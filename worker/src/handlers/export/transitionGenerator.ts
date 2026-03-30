/**
 * AI-powered transition video generator — SEAMLESS SCENE MORPHING.
 *
 * Creates automorphic transitions between scenes by:
 *   1. Extracting the last frame of scene N (start state)
 *   2. Extracting the first frame of scene N+1 (end state)
 *   3. Uploading BOTH frames to storage for AI API access
 *   4. Feeding BOTH frames to the I2V model (start_image → end_image)
 *   5. The AI generates a short video that seamlessly morphs between them
 *
 * The prompt explicitly describes the morphing: "The environment fluidly
 * and seamlessly morphs from [Scene A] directly into [Scene B], dissolving
 * smoothly without any hard cuts."
 *
 * Provider: Hypereal Grok Video I2V (image + end_image for interpolation)
 * Fallback: Replicate xai/grok-imagine-video (same params)
 */
import path from "path";
import fs from "fs";
import { runFfmpeg } from "./ffmpegCmd.js";
import { removeFiles } from "./storageHelpers.js";
import { generateSceneVideo, isAiVideoAvailable } from "../../services/sceneVideoGenerator.js";
import { supabase } from "../../lib/supabase.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TransitionRequest {
  /** Index of the "from" scene */
  fromSceneIndex: number;
  /** Path to the "from" scene MP4 */
  fromClipPath: string;
  /** Path to the "to" scene MP4 */
  toClipPath: string;
  /** Visual description of the outgoing scene (for prompt) */
  fromScenePrompt?: string;
  /** Visual description of the incoming scene (for prompt) */
  toScenePrompt?: string;
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
  /** Transition duration in seconds (default 2) */
  duration?: number;
  /** Project ID for logging */
  projectId?: string;
  /** User ID for logging */
  userId?: string;
  /** Timeout in ms (default 3 min) */
  timeoutMs?: number;
}

export interface TransitionResult {
  /** Path to the generated transition clip, or null on failure */
  path: string | null;
  /** Whether AI generation was used */
  aiGenerated: boolean;
  /** Duration of the transition in seconds */
  durationSeconds: number;
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

// ── Morphing Prompt Builder ──────────────────────────────────────────

function buildMorphingPrompt(
  fromPrompt: string | undefined,
  toPrompt: string | undefined,
  duration: number
): string {
  const fromDesc = fromPrompt ? fromPrompt.substring(0, 200) : "the current scene";
  const toDesc = toPrompt ? toPrompt.substring(0, 200) : "the next scene";

  return (
    `A continuous, single-take fly-through shot over ${duration} seconds. The camera is in constant dynamic motion, panning and moving forward. ` +
    `The shot begins on the provided starting frame showing ${fromDesc}, then the camera fluidly pushes past the foreground as the environment ` +
    `seamlessly morphs, stretches, and melts directly into the provided ending frame showing ${toDesc}. ` +
    `There are no hard cuts, only continuous forward camera movement with seamless, fluid object morphing bridging the two visual states.`
  );
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
    outputPath,
    tempDir,
    format,
    width,
    height,
    duration = 2,
    projectId = "unknown",
    userId,
    timeoutMs = 3 * 60 * 1000,
  } = request;

  const label = `${fromSceneIndex}→${fromSceneIndex + 1}`;

  if (!isAiVideoAvailable()) {
    return { path: null, aiGenerated: false, durationSeconds: 0, error: "No AI video API keys" };
  }

  console.log(`[TransitionGen] ${label}: generating ${duration}s morphing transition...`);

  const lastFramePath = path.join(tempDir, `trans_${fromSceneIndex}_lastframe.png`);
  const firstFramePath = path.join(tempDir, `trans_${fromSceneIndex}_firstframe.png`);

  try {
    // 1. Extract BOTH frames
    await Promise.all([
      extractLastFrame(fromClipPath, lastFramePath, width, height),
      extractFirstFrame(toClipPath, firstFramePath, width, height),
    ]);

    // 2. Upload BOTH frames for AI API access
    const [startFrameUrl, endFrameUrl] = await Promise.all([
      uploadFrameForAi(lastFramePath, projectId, `trans_${fromSceneIndex}_start`),
      uploadFrameForAi(firstFramePath, projectId, `trans_${fromSceneIndex}_end`),
    ]);

    console.log(`[TransitionGen] ${label}: both frames uploaded — start + end`);

    // 3. Build morphing prompt describing the transformation
    const morphPrompt = buildMorphingPrompt(fromScenePrompt, toScenePrompt, duration);

    // 4. Generate transition video with BOTH start and end images
    const result = await generateSceneVideo(
      {
        sceneIndex: fromSceneIndex,
        imageUrl: startFrameUrl,      // Start frame (Scene A's last frame)
        endImageUrl: endFrameUrl,     // End frame (Scene B's first frame)
        prompt: morphPrompt,
        format,
        duration,
        projectId,
        userId,
      },
      timeoutMs
    );

    if (!result.url) {
      console.warn(`[TransitionGen] ${label}: AI failed — ${result.error}`);
      return { path: null, aiGenerated: false, durationSeconds: 0, error: result.error };
    }

    // 5. Download and normalize the transition video
    const rawTransPath = path.join(tempDir, `trans_${fromSceneIndex}_raw.mp4`);
    const response = await fetch(result.url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
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
      "-t", String(duration),
      "-shortest",
      "-movflags", "+faststart",
      "-threads", "2",
      outputPath,
    ]);

    removeFiles(rawTransPath);
    console.log(`[TransitionGen] ${label}: ✅ morphing transition generated (${result.provider})`);

    return { path: outputPath, aiGenerated: true, durationSeconds: duration };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TransitionGen] ${label}: ❌ Failed — ${errorMsg}`);
    return { path: null, aiGenerated: false, durationSeconds: 0, error: errorMsg };
  } finally {
    removeFiles(lastFramePath, firstFramePath);
  }
}

/**
 * Generate morphing transition videos for all adjacent scene pairs.
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

    // Extract scene visual prompts for the morphing description
    const fromScene = scenes[i];
    const toScene = scenes[i + 1];
    const fromPrompt = fromScene?.visualPrompt || fromScene?.visual_prompt || fromScene?.voiceover;
    const toPrompt = toScene?.visualPrompt || toScene?.visual_prompt || toScene?.voiceover;

    const result = await generateTransitionVideo({
      fromSceneIndex: i,
      fromClipPath: clipPaths[i],
      toClipPath: clipPaths[i + 1],
      fromScenePrompt: fromPrompt,
      toScenePrompt: toPrompt,
      outputPath,
      tempDir,
      format: config.format,
      width: config.width,
      height: config.height,
      duration: config.duration || 2,
      projectId: config.projectId,
      userId: config.userId,
      timeoutMs: config.timeoutMs,
    });

    results.push(result);
  }

  const aiCount = results.filter((r) => r.aiGenerated).length;
  console.log(
    `[TransitionGen] ${aiCount}/${results.length} AI morphing transitions generated`
  );

  return results;
}
