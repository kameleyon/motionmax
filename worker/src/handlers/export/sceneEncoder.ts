/**
 * Encode a single scene into a normalised MP4 clip.
 *
 * Per-scene approach:
 *   • Still images → Ken Burns zoompan (pan/zoom motion) or static loop (fallback)
 *   • probeDuration on audio (fast, single ffprobe call)
 *   • Create video at probed duration → merge with audio via stream-copy
 *   • All outputs normalised to target resolution + 24fps + aac audio
 *
 * Export config flows in via ExportConfig so all clips share:
 *   - Same resolution (critical for crossfade transitions)
 *   - Same FPS, pixel format, audio codec
 *   - Ken Burns motion on image-based scenes
 */
import path from "path";
import { runFfmpeg, probeDuration, X264_MEM_FLAGS } from "./ffmpegCmd.js";
import { streamToFile, removeFiles } from "./storageHelpers.js";
import { concatFiles } from "./concatScenes.js";
import {
  getKenBurnsPreset,
  buildKenBurnsVf,
  logPreset,
} from "./kenBurns.js";
import {
  generateSceneVideo,
  isAiVideoAvailable,
} from "../../services/sceneVideoGenerator.js";

// ── Types ────────────────────────────────────────────────────────────

export interface ExportConfig {
  /** Target output width (default 1920) */
  width: number;
  /** Target output height (default 1080) */
  height: number;
  /** Target FPS (default 24) */
  fps: number;
  /** Enable Ken Burns pan/zoom on still images (default true) */
  kenBurns: boolean;
  /** Crossfade duration in seconds — 0 disables (default 0.5) */
  crossfadeDuration: number;
  /** Enable AI video generation for image scenes (default false) */
  aiVideo: boolean;
  /** Per-scene AI video timeout in ms (default 5 min) */
  aiVideoTimeoutMs: number;
  /** Enable AI transition video generation between scenes (default false) */
  aiTransitions: boolean;
  /** Per-transition AI video timeout in ms (default 3 min) */
  aiTransitionTimeoutMs: number;
  /** Output format string for AI providers */
  format: string;
  /** Project ID for logging */
  projectId?: string;
  /** User ID for logging */
  userId?: string;
}

/** Default export config for landscape format */
export const DEFAULT_EXPORT_CONFIG: ExportConfig = {
  width: 1920,
  height: 1080,
  fps: 24,
  kenBurns: true,
  crossfadeDuration: 0.5,
  aiVideo: false,
  aiVideoTimeoutMs: 5 * 60 * 1000,
  aiTransitions: false,
  aiTransitionTimeoutMs: 3 * 60 * 1000,
  format: "landscape",
};

// ── Constants ────────────────────────────────────────────────────────

/** Max seconds per static-image ffmpeg encode pass (no Ken Burns fallback). */
const MAX_CHUNK_SECONDS = 20;

/** Scale + pad filter to normalize any video to target resolution.
 *  Scales to fit (preserving aspect ratio), then pads to exact target. */
function scaleAndPad(w: number, h: number): string {
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `setsar=1`
  );
}

// ── Still Image Encoding ─────────────────────────────────────────────

/** Encode a still image into a video clip WITH Ken Burns motion. */
async function encodeWithKenBurns(
  imagePath: string,
  outputPath: string,
  duration: number,
  sceneIndex: number,
  config: ExportConfig
): Promise<void> {
  const preset = getKenBurnsPreset(sceneIndex);
  logPreset(sceneIndex, preset, duration);

  const vf = buildKenBurnsVf(preset, duration, config.fps, config.width, config.height);

  await runFfmpeg([
    "-loop", "1",
    "-framerate", "1",
    "-i", imagePath,
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-t", String(duration),
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    outputPath,
  ]);
}

/** Encode a static still-image segment (no Ken Burns, used as fallback). */
async function encodeSilentChunkStatic(
  imagePath: string,
  outputPath: string,
  duration: number,
  config: ExportConfig
): Promise<void> {
  await runFfmpeg([
    "-loop", "1",
    "-framerate", "2",
    "-i", imagePath,
    "-vf", scaleAndPad(config.width, config.height),
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-tune", "stillimage",
    "-pix_fmt", "yuv420p",
    "-r", String(config.fps),
    "-t", String(duration),
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    outputPath,
  ]);
}

/** Create a silent video from a still image for a given duration.
 *  Uses Ken Burns if enabled, with static fallback for long scenes or if disabled. */
async function imageToSilentClip(
  imagePath: string,
  outputPath: string,
  duration: number,
  sceneIndex: number,
  config: ExportConfig
): Promise<void> {
  if (config.kenBurns) {
    // Ken Burns handles full duration in one pass (no chunking needed —
    // zoompan generates frames on-the-fly with minimal memory)
    await encodeWithKenBurns(imagePath, outputPath, duration, sceneIndex, config);
    return;
  }

  // Fallback: static image (chunked for long durations to cap memory)
  if (duration <= MAX_CHUNK_SECONDS) {
    await encodeSilentChunkStatic(imagePath, outputPath, duration, config);
    return;
  }

  console.log(`[SceneEncoder] Chunking ${duration.toFixed(1)}s into ≤${MAX_CHUNK_SECONDS}s segments`);
  const chunks: string[] = [];
  let remaining = duration;
  let idx = 0;

  while (remaining > 0.1) {
    const chunkDur = Math.min(remaining, MAX_CHUNK_SECONDS);
    const chunkPath = outputPath.replace(".mp4", `_chunk${idx}.mp4`);
    await encodeSilentChunkStatic(imagePath, chunkPath, chunkDur, config);
    chunks.push(chunkPath);
    remaining -= chunkDur;
    idx++;
  }

  await concatFiles(chunks, outputPath, true);
  removeFiles(...chunks);
  console.log(`[SceneEncoder] Chunked encode complete (${chunks.length} segments)`);
}

// ── Audio Track Helpers ──────────────────────────────────────────────

/** Add a silent audio track to a video-only clip.
 *  Required for crossfade transitions (all clips must have audio). */
async function addSilentAudio(
  videoPath: string,
  outputPath: string,
  duration: number
): Promise<void> {
  await runFfmpeg([
    "-i", videoPath,
    "-f", "lavfi", "-i", `anullsrc=r=44100:cl=stereo`,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-t", String(duration),
    "-movflags", "+faststart",
    outputPath,
  ]);
}

// ── AI Video Enhancement ─────────────────────────────────────────────

/**
 * Attempt AI video generation for a scene's image.
 * Returns the local path to the downloaded AI video, or null on failure.
 * Falls back silently — caller should use Ken Burns as fallback.
 */
async function tryAiVideo(
  imageUrl: string,
  prompt: string,
  sceneIndex: number,
  tempDir: string,
  config: ExportConfig
): Promise<string | null> {
  if (!config.aiVideo || !isAiVideoAvailable()) return null;

  try {
    console.log(`[SceneEncoder] Scene ${sceneIndex}: attempting AI video generation...`);

    const result = await generateSceneVideo(
      {
        sceneIndex,
        imageUrl,
        prompt,
        format: config.format,
        duration: 5,
        projectId: config.projectId,
        userId: config.userId,
      },
      config.aiVideoTimeoutMs
    );

    if (!result.url) {
      console.warn(`[SceneEncoder] Scene ${sceneIndex}: AI video failed — ${result.error}. Falling back to Ken Burns.`);
      return null;
    }

    // Download the AI-generated video to local temp
    const aiVidPath = path.join(tempDir, `scene_${sceneIndex}_ai_raw.mp4`);
    await streamToFile(result.url, aiVidPath);
    console.log(`[SceneEncoder] Scene ${sceneIndex}: ✅ AI video downloaded (${result.provider})`);
    return aiVidPath;
  } catch (err) {
    console.warn(
      `[SceneEncoder] Scene ${sceneIndex}: AI video exception — ${(err as Error).message}. Falling back to Ken Burns.`
    );
    return null;
  }
}

// ── Scene Builders ───────────────────────────────────────────────────

/** Create a video clip from a still image + audio.
 *  When AI video is enabled, attempts to generate an AI video clip first,
 *  then falls back to Ken Burns if AI fails. */
async function imageAudioToClip(
  imagePath: string,
  imageUrl: string,
  prompt: string,
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number,
  config: ExportConfig
): Promise<number> {
  const audioDur = await probeDuration(audioPath);
  console.log(`[SceneEncoder] Scene ${sceneIndex} imageAudio: ${audioDur.toFixed(2)}s`);

  // Try AI video first (returns local path to downloaded video, or null)
  const aiVidPath = await tryAiVideo(imageUrl, prompt, sceneIndex, tempDir, config);

  if (aiVidPath) {
    // AI video succeeded — mux with audio (stretch to match audio duration)
    await muxVideoAudio(aiVidPath, audioPath, outputPath, tempDir, sceneIndex, config);
    removeFiles(aiVidPath);
    return audioDur;
  }

  // Fallback: Ken Burns on still image
  const silentVidPath = path.join(tempDir, `scene_${sceneIndex}_imgvid.mp4`);
  await imageToSilentClip(imagePath, silentVidPath, audioDur, sceneIndex, config);

  // Merge video + audio (stream-copy video)
  await runFfmpeg([
    "-i", silentVidPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ]);

  removeFiles(silentVidPath);
  return audioDur;
}

/** Mux video + audio with duration matching.
 *
 *  AUDIO IS KING — the voiceover is never cut, sped up, or modified.
 *  The video is stretched/looped to match audio duration + 1s safety padding.
 *  This ensures voiceovers are never clipped, even with crossfade trimming.
 *
 *  Strategy:
 *    1. Target clip duration = audio duration + 1s padding
 *    2. Loop video if needed, stretch via setpts to fill the full duration
 *    3. Generate silent audio to fill the gap between voiceover end and clip end
 *    4. The extra 1s is pure silence — crossfade trims into silence, not speech
 */
async function muxVideoAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number,
  config: ExportConfig
): Promise<void> {
  const [videoDur, audioDur] = await Promise.all([
    probeDuration(videoPath),
    probeDuration(audioPath),
  ]);

  // Add 1s safety padding so crossfade trimming cuts silence, not speech
  const AUDIO_PAD_SECONDS = 1.0;
  const clipDuration = audioDur + AUDIO_PAD_SECONDS;
  const ratio = clipDuration / videoDur;

  console.log(
    `[SceneEncoder] Scene ${sceneIndex} mux: video=${videoDur.toFixed(1)}s audio=${audioDur.toFixed(1)}s ` +
    `clip=${clipDuration.toFixed(1)}s ratio=${ratio.toFixed(3)}`
  );

  // Loop video if it's shorter than the target clip duration
  const videoInputArgs = videoDur < clipDuration
    ? ["-stream_loop", "-1", "-i", videoPath]
    : ["-i", videoPath];

  // Use the real audio + a silent audio source, then overlay them.
  // The silent source ensures the audio track extends to clipDuration
  // without using apad (which can fail on non-standard channel layouts).
  await runFfmpeg([
    ...videoInputArgs,
    "-i", audioPath,
    "-f", "lavfi", "-i", `anullsrc=r=44100:cl=stereo`,
    "-filter_complex",
    [
      // Normalize audio to stereo 44100Hz, then concat with silence to fill duration
      `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[speech]`,
      `[2:a]atrim=0:${AUDIO_PAD_SECONDS.toFixed(1)}[silence]`,
      `[speech][silence]concat=n=2:v=0:a=1[aout]`,
    ].join(";"),
    "-vf", `setpts=${ratio.toFixed(6)}*PTS,${scaleAndPad(config.width, config.height)}`,
    "-map", "0:v:0",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-t", String(clipDuration),
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    outputPath,
  ]);
}

/** Build a slideshow from multiple images + one audio track. */
async function slideshowFromImages(
  imageUrls: string[],
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number,
  config: ExportConfig
): Promise<void> {
  const audioDur = await probeDuration(audioPath);
  const n = imageUrls.length;
  const perImgDur = audioDur / n;

  // 1. Create a clip per sub-image (with Ken Burns if enabled)
  const subClips: string[] = [];
  for (let j = 0; j < n; j++) {
    const imgPath = path.join(tempDir, `scene_${sceneIndex}_img${j}.png`);
    const subPath = path.join(tempDir, `scene_${sceneIndex}_sub${j}.mp4`);
    await streamToFile(imageUrls[j], imgPath);

    // Each sub-image in a slideshow gets its own Ken Burns preset
    // Offset by sub-index for variety within the scene
    await imageToSilentClip(imgPath, subPath, perImgDur, sceneIndex * 10 + j, config);

    removeFiles(imgPath);
    subClips.push(subPath);
  }

  // 2. Concatenate sub-clips (stream-copy — identical codec)
  const slideshowPath = path.join(tempDir, `scene_${sceneIndex}_slideshow.mp4`);
  await concatFiles(subClips, slideshowPath, true);
  removeFiles(...subClips);

  // 3. Add audio track (stream-copy video)
  await runFfmpeg([
    "-i", slideshowPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ]);

  removeFiles(slideshowPath);
}

// ── Main Entry Point ─────────────────────────────────────────────────

/** Process one scene → local MP4 (normalised to target resolution with audio track). */
export async function processScene(
  i: number,
  scene: any,
  tempDir: string,
  config: ExportConfig = DEFAULT_EXPORT_CONFIG
): Promise<{ index: number; path: string | null }> {
  const localPath = path.join(tempDir, `scene_${i}.mp4`);

  try {
    // ── Video + Audio scene (cinematic / AI video) ──
    if (scene.videoUrl && scene.audioUrl) {
      const vidPath = path.join(tempDir, `scene_${i}_vid.mp4`);
      const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
      console.log(`[SceneEncoder] Scene ${i}: video+audio → mux`);
      await streamToFile(scene.videoUrl, vidPath);
      await streamToFile(scene.audioUrl, audPath);
      await muxVideoAudio(vidPath, audPath, localPath, tempDir, i, config);
      removeFiles(vidPath, audPath);
      return { index: i, path: localPath };
    }

    // ── Video only (no audio) ──
    if (scene.videoUrl) {
      const vidPath = path.join(tempDir, `scene_${i}_vid_raw.mp4`);
      console.log(`[SceneEncoder] Scene ${i}: video only → normalize + silent audio`);
      await streamToFile(scene.videoUrl, vidPath);

      // Normalize resolution
      const normalizedPath = path.join(tempDir, `scene_${i}_vid_norm.mp4`);
      await runFfmpeg([
        "-i", vidPath,
        "-vf", scaleAndPad(config.width, config.height),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        ...X264_MEM_FLAGS,
        normalizedPath,
      ]);
      removeFiles(vidPath);

      // Add silent audio for crossfade compatibility
      const dur = await probeDuration(normalizedPath);
      await addSilentAudio(normalizedPath, localPath, dur);
      removeFiles(normalizedPath);
      return { index: i, path: localPath };
    }

    // ── Multi-image slideshow + audio ──
    const validImageUrls: string[] = Array.isArray(scene.imageUrls)
      ? scene.imageUrls.filter(Boolean)
      : [];

    if (validImageUrls.length > 1 && scene.audioUrl) {
      const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
      console.log(`[SceneEncoder] Scene ${i}: ${validImageUrls.length} images+audio → slideshow`);
      await streamToFile(scene.audioUrl, audPath);
      await slideshowFromImages(validImageUrls, audPath, localPath, tempDir, i, config);
      removeFiles(audPath);
      return { index: i, path: localPath };
    }

    // ── Single image + audio ──
    if (scene.imageUrl && scene.audioUrl) {
      const imgPath = path.join(tempDir, `scene_${i}_img.png`);
      const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
      const scenePrompt = scene.visualPrompt || scene.visual_prompt || scene.voiceover || "";
      const mode = config.aiVideo ? "AI video → Ken Burns fallback" : "Ken Burns";
      console.log(`[SceneEncoder] Scene ${i}: image+audio → ${mode}`);
      await streamToFile(scene.imageUrl, imgPath);
      await streamToFile(scene.audioUrl, audPath);
      const dur = await imageAudioToClip(imgPath, scene.imageUrl, scenePrompt, audPath, localPath, tempDir, i, config);
      console.log(`[SceneEncoder] Scene ${i}: done (${dur.toFixed(1)}s)`);
      removeFiles(imgPath, audPath);
      return { index: i, path: localPath };
    }

    // ── Single image only (no audio) ──
    if (scene.imageUrl) {
      const imgPath = path.join(tempDir, `scene_${i}_img.png`);
      console.log(`[SceneEncoder] Scene ${i}: image → Ken Burns + silent audio`);
      await streamToFile(scene.imageUrl, imgPath);

      const duration = scene.duration || 5;
      const silentVidPath = path.join(tempDir, `scene_${i}_imgonly.mp4`);
      await imageToSilentClip(imgPath, silentVidPath, duration, i, config);
      removeFiles(imgPath);

      // Add silent audio for crossfade compatibility
      await addSilentAudio(silentVidPath, localPath, duration);
      removeFiles(silentVidPath);
      return { index: i, path: localPath };
    }

    console.warn(`[SceneEncoder] Scene ${i}: no usable URL — skipping`);
    return { index: i, path: null };
  } catch (err) {
    console.error(`[SceneEncoder] Scene ${i} failed:`, (err as Error).message);
    throw err;
  }
}
