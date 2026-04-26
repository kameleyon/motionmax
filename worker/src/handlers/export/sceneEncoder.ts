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
import fs from "fs";
import { runFfmpeg, probeDuration, getExactAudioDuration, X264_MEM_FLAGS } from "./ffmpegCmd.js";
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
  kenBurns: false,
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
): Promise<{ path: string; sourceUrl: string } | null> {
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
    await streamToFile(result.url, aiVidPath, "video");
    console.log(`[SceneEncoder] Scene ${sceneIndex}: ✅ AI video downloaded (${result.provider})`);
    // Return the source URL too so the caller can pass it to
    // muxVideoAudio for one-shot re-download on probe failure.
    return { path: aiVidPath, sourceUrl: result.url };
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
  const audioDur = await getExactAudioDuration(audioPath);
  console.log(`[SceneEncoder] Scene ${sceneIndex} imageAudio: ${audioDur.toFixed(2)}s`);

  // Try AI video first (returns { path, sourceUrl } or null)
  const aiVid = await tryAiVideo(imageUrl, prompt, sceneIndex, tempDir, config);

  if (aiVid) {
    // AI video succeeded — mux with audio (stretch to match audio duration).
    // Pass the AI video's source URL so muxVideoAudio can re-fetch on
    // probe failure. The audio path here is local-derived from
    // scene.audioUrl upstream; we don't re-thread it because
    // imageAudioToClip's audioPath was already validated by streamToFile.
    await muxVideoAudio(aiVid.path, audioPath, outputPath, tempDir, sceneIndex, config, {
      video: aiVid.sourceUrl,
    });
    removeFiles(aiVid.path);
    return audioDur;
  }

  // Fallback: Ken Burns on still image
  const silentVidPath = path.join(tempDir, `scene_${sceneIndex}_imgvid.mp4`);
  await imageToSilentClip(imagePath, silentVidPath, audioDur, sceneIndex, config);

  // Merge video + audio (stream-copy video, re-encode audio)
  // -t caps output at audioDur to prevent filter-graph reinit when one
  // input outlasts the other (WAV files from TTS often have unknown RIFF
  // data size, causing probeDuration to return 10 as fallback).
  await runFfmpeg([
    "-i", silentVidPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-t", String(audioDur),
    "-movflags", "+faststart",
    outputPath,
  ]);

  removeFiles(silentVidPath);
  return audioDur;
}

/** Probe video + audio durations with a single retry on failure.
 *
 *  Defense against the "ffprobe: Command failed" symptom: a download
 *  can satisfy the magic-byte + size validators in streamToFile but
 *  still be unparseable by ffprobe (truncated stream, missing moov
 *  atom, etc.). On the first probe failure we log file sizes, unlink
 *  the bad file(s), re-fetch each via a fresh signed URL, then retry
 *  the probe. A second failure surfaces a clear error including the
 *  file size and source URL — at that point the source media is
 *  genuinely broken and the user needs to know. */
async function probeWithRetry(
  videoPath: string,
  audioPath: string,
  sceneIndex: number,
  sourceUrls?: { video?: string; audio?: string },
): Promise<[number, number]> {
  try {
    return await Promise.all([
      probeDuration(videoPath),
      getExactAudioDuration(audioPath),
    ]);
  } catch (firstErr) {
    const firstMsg = (firstErr as Error).message;
    // Best-effort size logging so the operator can correlate "scene N
    // failed" with the actual on-disk state.
    const [vidStat, audStat] = await Promise.all([
      fs.promises.stat(videoPath).catch(() => null),
      fs.promises.stat(audioPath).catch(() => null),
    ]);
    console.warn(
      `[SceneEncoder] Scene ${sceneIndex}: probe failed (${firstMsg}). ` +
      `video=${vidStat?.size ?? "missing"}B audio=${audStat?.size ?? "missing"}B. ` +
      `Re-downloading and retrying once...`,
    );

    // Without a source URL we can't re-fetch — re-throw with the
    // additional size context so the user sees the actual file state.
    if (!sourceUrls?.video && !sourceUrls?.audio) {
      throw new Error(
        `Scene ${sceneIndex} probe failed and no source URL available to retry: ` +
        `video=${vidStat?.size ?? "missing"}B audio=${audStat?.size ?? "missing"}B — ${firstMsg}`,
      );
    }

    // Re-fetch the file(s) for which we have a source URL. Unlink
    // first so streamToFile writes fresh bytes (no stale handle, no
    // append). resolveFetchUrl inside streamToFile will mint a fresh
    // signed URL automatically.
    const refetches: Promise<void>[] = [];
    if (sourceUrls?.video) {
      try { await fs.promises.unlink(videoPath); } catch { /* ignore */ }
      refetches.push(streamToFile(sourceUrls.video, videoPath, "video"));
    }
    if (sourceUrls?.audio) {
      try { await fs.promises.unlink(audioPath); } catch { /* ignore */ }
      refetches.push(streamToFile(sourceUrls.audio, audioPath, "audio"));
    }
    await Promise.all(refetches);

    try {
      const result = await Promise.all([
        probeDuration(videoPath),
        getExactAudioDuration(audioPath),
      ]);
      console.log(`[SceneEncoder] Scene ${sceneIndex}: probe succeeded after re-download retry`);
      return result;
    } catch (secondErr) {
      const [vidStat2, audStat2] = await Promise.all([
        fs.promises.stat(videoPath).catch(() => null),
        fs.promises.stat(audioPath).catch(() => null),
      ]);
      throw new Error(
        `Scene ${sceneIndex} probe failed after retry: ` +
        `video=${vidStat2?.size ?? "missing"}B audio=${audStat2?.size ?? "missing"}B ` +
        `videoUrl=${sourceUrls?.video ?? "n/a"} audioUrl=${sourceUrls?.audio ?? "n/a"} ` +
        `— ${(secondErr as Error).message}`,
      );
    }
  }
}

/** Mux video + audio with duration matching.
 *
 *  AUDIO IS KING — the voiceover is never cut, sped up, or modified.
 *  The video is speed-adjusted (setpts) so its duration exactly matches the audio.
 *
 *  Strategy:
 *    1. Probe both video and audio durations
 *    2. Compute setpts factor = audioDur / videoDur
 *       - If audio is longer → factor > 1 → video slows down (stretches)
 *       - If audio is shorter → factor < 1 → video speeds up
 *    3. No looping, no padding — output duration = audio duration exactly
 *    4. Audio is passed through as-is (no resampling, no filter chain)
 */
async function muxVideoAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number,
  config: ExportConfig,
  /** Optional source URLs — if provided, a probe failure will trigger
   *  ONE re-download with a fresh signed URL before bailing. This
   *  catches the case where the file passes the magic-byte + size
   *  validators in streamToFile but ffprobe still can't parse it
   *  (e.g. truncated stream, missing moov atom). One retry is enough:
   *  if a freshly-signed URL also produces an unprobable file, the
   *  source media is genuinely broken and the user should know. */
  sourceUrls?: { video?: string; audio?: string },
): Promise<void> {
  const [videoDur, audioDur] = await probeWithRetry(
    videoPath,
    audioPath,
    sceneIndex,
    sourceUrls,
  );

  // AUDIO IS KING — video duration must EXACTLY match audio duration.
  const clipDuration = audioDur;
  const speedRatio = videoDur / audioDur;
  const setptsFactor = (audioDur / videoDur).toFixed(6);

  console.log(
    `[SceneEncoder] Scene ${sceneIndex} mux: video=${videoDur.toFixed(1)}s audio=${audioDur.toFixed(1)}s ` +
    `speed=${speedRatio.toFixed(2)}x setpts=${setptsFactor}`
  );

  await runFfmpeg([
    "-i", videoPath,
    "-i", audioPath,
    "-vf", `setpts=${setptsFactor}*PTS,${scaleAndPad(config.width, config.height)}`,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
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
  const audioDur = await getExactAudioDuration(audioPath);
  const n = imageUrls.length;
  const perImgDur = audioDur / n;

  // 1. Create a clip per sub-image (with Ken Burns if enabled)
  const subClips: string[] = [];
  for (let j = 0; j < n; j++) {
    const imgPath = path.join(tempDir, `scene_${sceneIndex}_img${j}.png`);
    const subPath = path.join(tempDir, `scene_${sceneIndex}_sub${j}.mp4`);
    await streamToFile(imageUrls[j], imgPath, "image");

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

  // 3. Add audio track (stream-copy video, re-encode audio to normalize format)
  await runFfmpeg([
    "-i", slideshowPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-t", String(audioDur),
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
      await Promise.all([
        streamToFile(scene.videoUrl, vidPath, "video"),
        streamToFile(scene.audioUrl, audPath, "audio"),
      ]);
      // Pass source URLs so muxVideoAudio can re-fetch on probe failure.
      // This is the path that produced the "ffprobe: Command failed"
      // symptom — a downloaded MP4 that passed magic-byte+size checks
      // but had a truncated tail / missing moov atom.
      await muxVideoAudio(vidPath, audPath, localPath, tempDir, i, config, {
        video: scene.videoUrl,
        audio: scene.audioUrl,
      });
      removeFiles(vidPath, audPath);
      return { index: i, path: localPath };
    }

    // ── Video only (no audio) ──
    if (scene.videoUrl) {
      const vidPath = path.join(tempDir, `scene_${i}_vid_raw.mp4`);
      console.log(`[SceneEncoder] Scene ${i}: video only → normalize + silent audio`);
      await streamToFile(scene.videoUrl, vidPath, "video");

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
      await streamToFile(scene.audioUrl, audPath, "audio");
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
      await Promise.all([
        streamToFile(scene.imageUrl, imgPath, "image"),
        streamToFile(scene.audioUrl, audPath, "audio"),
      ]);
      const dur = await imageAudioToClip(imgPath, scene.imageUrl, scenePrompt, audPath, localPath, tempDir, i, config);
      console.log(`[SceneEncoder] Scene ${i}: done (${dur.toFixed(1)}s)`);
      removeFiles(imgPath, audPath);
      return { index: i, path: localPath };
    }

    // ── Single image only (no audio) ──
    if (scene.imageUrl) {
      const imgPath = path.join(tempDir, `scene_${i}_img.png`);
      console.log(`[SceneEncoder] Scene ${i}: image → Ken Burns + silent audio`);
      await streamToFile(scene.imageUrl, imgPath, "image");

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
