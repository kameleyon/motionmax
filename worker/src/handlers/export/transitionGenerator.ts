/**
 * AI-powered transition video generator.
 *
 * Generates seamless morphing transitions between scenes by:
 *   1. Extracting the last frame of scene N
 *   2. Extracting the first frame of scene N+1
 *   3. Feeding both frames to an image-to-video AI model
 *   4. The AI generates a short (2-3s) video that morphs between the two frames
 *
 * The resulting transition clips are inserted between scene clips during export,
 * creating cinema-grade seamless scene changes.
 *
 * Provider: Hypereal Grok Video I2V (image-to-video with start frame)
 * Fallback: If AI fails, returns null (caller uses crossfade instead)
 */
import path from "path";
import fs from "fs";
import { runFfmpeg } from "./ffmpegCmd.js";
import { removeFiles } from "./storageHelpers.js";
import { generateSceneVideo, isAiVideoAvailable } from "../../services/sceneVideoGenerator.js";
import { supabase } from "../../lib/supabase.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TransitionRequest {
  /** Index of the "from" scene (for logging) */
  fromSceneIndex: number;
  /** Path to the "from" scene MP4 */
  fromClipPath: string;
  /** Path to the "to" scene MP4 */
  toClipPath: string;
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
  /** Whether AI generation was used (vs. skipped) */
  aiGenerated: boolean;
  /** Duration of the transition in seconds */
  durationSeconds: number;
  /** Error message if generation failed */
  error?: string;
}

// ── Frame Extraction ─────────────────────────────────────────────────

/**
 * Extract the last frame of a video as a PNG image.
 * Uses ffmpeg to seek near the end and grab the final frame.
 */
async function extractLastFrame(
  videoPath: string,
  outputPath: string,
  width: number,
  height: number
): Promise<void> {
  // Use sseof to seek from the end — more reliable than computing duration
  await runFfmpeg([
    "-sseof", "-0.1",      // seek to 0.1s before end
    "-i", videoPath,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "-frames:v", "1",
    "-q:v", "2",            // high quality JPEG/PNG
    outputPath,
  ], 30_000);
}

/**
 * Extract the first frame of a video as a PNG image.
 */
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

/**
 * Upload a local frame image to Supabase storage for AI API access.
 * Returns the public URL. Cleans up after the transition is generated.
 */
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

// ── Main API ─────────────────────────────────────────────────────────

/**
 * Generate an AI-powered transition video between two scenes.
 *
 * Flow:
 *   1. Extract last frame of scene N → upload to storage
 *   2. Feed to Grok Video I2V with a "morph/transition" prompt
 *   3. Download the result → normalize to target resolution
 *   4. Return the local path to the transition clip
 *
 * Returns null path on failure (caller should use crossfade instead).
 */
export async function generateTransitionVideo(
  request: TransitionRequest
): Promise<TransitionResult> {
  const {
    fromSceneIndex,
    fromClipPath,
    toClipPath,
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

  const transLabel = `${fromSceneIndex}→${fromSceneIndex + 1}`;

  if (!isAiVideoAvailable()) {
    return { path: null, aiGenerated: false, durationSeconds: 0, error: "No AI video API keys configured" };
  }

  console.log(`[TransitionGen] ${transLabel}: generating ${duration}s AI transition...`);

  const lastFramePath = path.join(tempDir, `trans_${fromSceneIndex}_lastframe.png`);
  const firstFramePath = path.join(tempDir, `trans_${fromSceneIndex}_firstframe.png`);

  try {
    // 1. Extract frames
    await Promise.all([
      extractLastFrame(fromClipPath, lastFramePath, width, height),
      extractFirstFrame(toClipPath, firstFramePath, width, height),
    ]);

    // 2. Upload the "from" frame for AI API access
    // We use the last frame of the outgoing scene as the I2V source
    const frameUrl = await uploadFrameForAi(lastFramePath, projectId, `trans_${fromSceneIndex}`);

    // 3. Generate transition video via AI
    // The prompt describes morphing FROM the current scene TO the next
    const transitionPrompt =
      `Smooth cinematic transition. Camera slowly moves forward through the scene. ` +
      `The composition gradually shifts and transforms. ` +
      `Fluid, dreamlike motion. Seamless visual flow. Duration: ${duration} seconds.`;

    const result = await generateSceneVideo(
      {
        sceneIndex: fromSceneIndex,
        imageUrl: frameUrl,
        prompt: transitionPrompt,
        format,
        duration,
        projectId,
        userId,
      },
      timeoutMs
    );

    if (!result.url) {
      console.warn(`[TransitionGen] ${transLabel}: AI failed — ${result.error}`);
      return { path: null, aiGenerated: false, durationSeconds: 0, error: result.error };
    }

    // 4. Download and normalize the transition video
    const rawTransPath = path.join(tempDir, `trans_${fromSceneIndex}_raw.mp4`);
    const response = await fetch(result.url);
    if (!response.ok) throw new Error(`Failed to download transition video: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(rawTransPath, buffer);

    // Normalize to target resolution + add silent audio
    await runFfmpeg([
      "-i", rawTransPath,
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
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
    console.log(`[TransitionGen] ${transLabel}: ✅ AI transition generated (${result.provider})`);

    return { path: outputPath, aiGenerated: true, durationSeconds: duration };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TransitionGen] ${transLabel}: ❌ Failed — ${errorMsg}`);
    return { path: null, aiGenerated: false, durationSeconds: 0, error: errorMsg };
  } finally {
    // Clean up temp frame files
    removeFiles(lastFramePath, firstFramePath);
  }
}

/**
 * Generate transition videos for all adjacent scene pairs.
 *
 * Returns an array of TransitionResult, one per scene junction (length = clipCount - 1).
 * Null paths mean that junction should use crossfade instead.
 */
export async function generateAllTransitions(
  clipPaths: string[],
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

  // Generate transitions sequentially to avoid overwhelming the API
  for (let i = 0; i < clipPaths.length - 1; i++) {
    const outputPath = path.join(tempDir, `transition_${i}_${i + 1}.mp4`);

    const result = await generateTransitionVideo({
      fromSceneIndex: i,
      fromClipPath: clipPaths[i],
      toClipPath: clipPaths[i + 1],
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
    `[TransitionGen] Generated ${aiCount}/${results.length} AI transitions ` +
    `(${results.length - aiCount} will use crossfade fallback)`
  );

  return results;
}
