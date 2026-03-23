/**
 * Encode a single scene into a normalised MP4 clip.
 *
 * Optimised for multi-user worker: minimal ffmpeg calls per scene
 * so the worker can handle generation + export jobs concurrently.
 *
 * Per-scene approach:
 *   • probeDuration on audio (fast, single ffprobe call)
 *   • Create silent video at probed duration
 *   • Merge video + audio via stream-copy (no re-encode)
 *
 * Long still-image scenes (>20s) are chunked into shorter segments
 * then concatenated — prevents OOM on constrained Render instances.
 */
import path from "path";
import { runFfmpeg, probeDuration, X264_MEM_FLAGS } from "./ffmpegCmd.js";
import { streamToFile, removeFiles } from "./storageHelpers.js";
import { concatFiles } from "./concatScenes.js";

/** Max seconds per ffmpeg encode pass — keeps x264 peak memory low. */
const MAX_CHUNK_SECONDS = 20;

/** Shared video filter: cap to 1920px wide + ensure even dimensions. */
const SCALE_FIT =
  "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease," +
  "scale=trunc(iw/2)*2:trunc(ih/2)*2";

/** Encode a ≤ MAX_CHUNK_SECONDS still-image segment. */
async function encodeSilentChunk(
  imagePath: string,
  outputPath: string,
  duration: number
): Promise<void> {
  await runFfmpeg([
    "-loop", "1",
    "-framerate", "2",
    "-i", imagePath,
    "-vf", SCALE_FIT,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "stillimage",
    "-pix_fmt", "yuv420p",
    "-r", "24",
    "-t", String(duration),
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    outputPath,
  ]);
}

/** Create a silent video from a still image for a given duration.
 *  For clips longer than MAX_CHUNK_SECONDS the encode is split into
 *  shorter segments and concatenated — this caps x264's peak memory and
 *  prevents OOM-kills on constrained servers. */
async function imageToSilentClip(
  imagePath: string,
  outputPath: string,
  duration: number
): Promise<void> {
  if (duration <= MAX_CHUNK_SECONDS) {
    await encodeSilentChunk(imagePath, outputPath, duration);
    return;
  }

  // ── Chunked encode for long durations ──
  console.log(`[SceneEncoder] Chunking ${duration.toFixed(1)}s into ≤${MAX_CHUNK_SECONDS}s segments`);
  const chunks: string[] = [];
  let remaining = duration;
  let idx = 0;

  while (remaining > 0.1) {
    const chunkDur = Math.min(remaining, MAX_CHUNK_SECONDS);
    const chunkPath = outputPath.replace(".mp4", `_chunk${idx}.mp4`);
    await encodeSilentChunk(imagePath, chunkPath, chunkDur);
    chunks.push(chunkPath);
    remaining -= chunkDur;
    idx++;
  }

  await concatFiles(chunks, outputPath, true);
  removeFiles(...chunks);
  console.log(`[SceneEncoder] Chunked encode complete (${chunks.length} segments)`);
}

/** Create a video clip from a still image + audio.
 *  2 ffmpeg calls: silent video → merge with audio (stream-copy). */
async function imageAudioToClip(
  imagePath: string,
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number
): Promise<number> {
  const audioDur = await probeDuration(audioPath);
  console.log(`[SceneEncoder] Scene ${sceneIndex} imageAudio: ${audioDur.toFixed(2)}s`);

  // Pass 1: silent video at audio duration (chunked if long)
  const silentVidPath = path.join(tempDir, `scene_${sceneIndex}_imgvid.mp4`);
  await imageToSilentClip(imagePath, silentVidPath, audioDur);

  // Pass 2: merge video + audio (stream-copy both)
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

/** Mux video + audio: video is stretched to be LONGER than audio.
 *  Audio is the master clock — the output plays the full audio track.
 *  Video extends a few seconds past audio end (frozen last frame). */
async function muxVideoAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number
): Promise<void> {
  const [videoDur, audioDur] = await Promise.all([
    probeDuration(videoPath),
    probeDuration(audioPath),
  ]);

  // Stretch video to audio duration + 5s buffer — video MUST outlast audio
  const AUDIO_SAFETY_BUFFER = 5;
  const targetDur = audioDur + AUDIO_SAFETY_BUFFER;
  const ratio = targetDur / videoDur;
  console.log(
    `[SceneEncoder] Scene ${sceneIndex} mux: video=${videoDur.toFixed(1)}s audio=${audioDur.toFixed(1)}s target=${targetDur.toFixed(1)}s ratio=${ratio.toFixed(2)}x`
  );

  // Pass 1: stretch + normalize video (overshoots audio by buffer)
  const stretchedVid = path.join(tempDir, `scene_${sceneIndex}_stretched.mp4`);
  await runFfmpeg([
    "-i", videoPath,
    "-vf", `setpts=${ratio.toFixed(4)}*PTS,${SCALE_FIT}`,
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    stretchedVid,
  ]);

  // Pass 2: merge with audio — NO -t trim, let audio play fully.
  // The video is longer than the audio, so the audio track dictates
  // the perceived clip length. Extra video frames are harmless.
  await runFfmpeg([
    "-i", stretchedVid,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ]);

  removeFiles(stretchedVid);
}

/** Build a slideshow from multiple images + one audio track. */
async function slideshowFromImages(
  imageUrls: string[],
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number
): Promise<void> {
  const audioDur = await probeDuration(audioPath);
  const n = imageUrls.length;
  const perImgDur = audioDur / n;

  // 1. Create a silent clip per sub-image (chunked if long)
  const subClips: string[] = [];
  for (let j = 0; j < n; j++) {
    const imgPath = path.join(tempDir, `scene_${sceneIndex}_img${j}.png`);
    const subPath = path.join(tempDir, `scene_${sceneIndex}_sub${j}.mp4`);
    await streamToFile(imageUrls[j], imgPath);
    await imageToSilentClip(imgPath, subPath, perImgDur);
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

/** Process one scene → local MP4 (normalised). */
export async function processScene(
  i: number,
  scene: any,
  tempDir: string
): Promise<{ index: number; path: string | null }> {
  const localPath = path.join(tempDir, `scene_${i}.mp4`);

  try {
    if (scene.videoUrl && scene.audioUrl) {
      const vidPath = path.join(tempDir, `scene_${i}_vid.mp4`);
      const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
      console.log(`[SceneEncoder] Scene ${i}: video+audio → mux`);
      await streamToFile(scene.videoUrl, vidPath);
      await streamToFile(scene.audioUrl, audPath);
      await muxVideoAudio(vidPath, audPath, localPath, tempDir, i);
      removeFiles(vidPath, audPath);
      return { index: i, path: localPath };
    }

    if (scene.videoUrl) {
      console.log(`[SceneEncoder] Scene ${i}: downloading video`);
      await streamToFile(scene.videoUrl, localPath);
      return { index: i, path: localPath };
    }

    const validImageUrls: string[] = Array.isArray(scene.imageUrls)
      ? scene.imageUrls.filter(Boolean)
      : [];

    if (validImageUrls.length > 1 && scene.audioUrl) {
      const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
      console.log(`[SceneEncoder] Scene ${i}: ${validImageUrls.length} images+audio → slideshow`);
      await streamToFile(scene.audioUrl, audPath);
      await slideshowFromImages(validImageUrls, audPath, localPath, tempDir, i);
      removeFiles(audPath);
      return { index: i, path: localPath };
    }

    if (scene.imageUrl && scene.audioUrl) {
      const imgPath = path.join(tempDir, `scene_${i}_img.png`);
      const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
      console.log(`[SceneEncoder] Scene ${i}: image+audio → clip`);
      await streamToFile(scene.imageUrl, imgPath);
      await streamToFile(scene.audioUrl, audPath);
      const dur = await imageAudioToClip(imgPath, audPath, localPath, tempDir, i);
      console.log(`[SceneEncoder] Scene ${i}: done (${dur.toFixed(1)}s)`);
      removeFiles(imgPath, audPath);
      return { index: i, path: localPath };
    }

    if (scene.imageUrl) {
      const imgPath = path.join(tempDir, `scene_${i}_img.png`);
      console.log(`[SceneEncoder] Scene ${i}: image → silent clip`);
      await streamToFile(scene.imageUrl, imgPath);
      const duration = scene.duration || 5;
      await imageToSilentClip(imgPath, localPath, duration);
      removeFiles(imgPath);
      return { index: i, path: localPath };
    }

    console.warn(`[SceneEncoder] Scene ${i}: no usable URL — skipping`);
    return { index: i, path: null };
  } catch (err) {
    console.error(`[SceneEncoder] Scene ${i} failed:`, (err as Error).message);
    throw err;
  }
}
