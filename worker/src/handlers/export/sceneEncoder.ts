/**
 * Encode a single scene into a normalised MP4 clip.
 *
 * Every scene is output as:
 *   • H.264 yuv420p, 24 fps, ultrafast preset
 *   • AAC 128 kbps audio (or silent if none)
 *   • Even-dimension resolution via the scale filter
 *
 * All ffmpeg calls use SIMPLE filters (-vf) — never -filter_complex —
 * which eliminates the "Error initializing complex filters" crash.
 */
import path from "path";
import { runFfmpeg, probeDuration, X264_MEM_FLAGS } from "./ffmpegCmd.js";
import { streamToFile, removeFiles } from "./storageHelpers.js";
import { concatFiles } from "./concatScenes.js";

/** Shared video filter: ensure even dimensions for yuv420p */
const SCALE_EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

/** Create a video clip from a still image + audio file.
 *  Uses a reliable 2-pass approach:
 *    Pass 1 → silent video from image at exact audio duration (single input, no -shortest)
 *    Pass 2 → merge audio via stream-copy (no re-encoding)
 *  This guarantees the full audio plays without any clipping. */
async function imageAudioToClip(
  imagePath: string,
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number
): Promise<number> {
  // Probe the REAL audio duration — never trust metadata
  const audioDur = await probeDuration(audioPath);
  console.log(`[SceneEncoder] imageAudioToClip scene ${sceneIndex}: audio=${audioDur.toFixed(2)}s`);

  // Pass 1: create a silent video at exact audio duration (single input → reliable -t)
  const silentVidPath = path.join(tempDir, `scene_${sceneIndex}_imgvid.mp4`);
  await imageToSilentClip(imagePath, silentVidPath, audioDur);

  // Pass 2: merge silent video + audio (stream-copy video, encode audio)
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

/** Create a silent video from a still image for a given duration. */
async function imageToSilentClip(
  imagePath: string,
  outputPath: string,
  duration: number
): Promise<void> {
  await runFfmpeg([
    "-loop", "1",
    "-framerate", "24",
    "-i", imagePath,
    "-vf", SCALE_EVEN,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "stillimage",
    "-pix_fmt", "yuv420p",
    "-t", String(duration),
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    outputPath,
  ]);
}

/** Mux video + audio: stretch video speed to match audio duration.
 *  Uses ONLY simple -vf (one input at a time): first re-encode video,
 *  then combine with audio in a second pass (stream copy). */
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
  const ratio = audioDur / videoDur;
  console.log(
    `[SceneEncoder] Scene ${sceneIndex}: video ${videoDur.toFixed(1)}s → audio ${audioDur.toFixed(1)}s (${ratio.toFixed(2)}x)`
  );

  // Pass 1: stretch + normalize video (single input → simple -vf)
  const stretchedVid = path.join(tempDir, `scene_${sceneIndex}_stretched.mp4`);
  await runFfmpeg([
    "-i", videoPath,
    "-vf", `setpts=${ratio.toFixed(4)}*PTS,${SCALE_EVEN}`,
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    stretchedVid,
  ]);

  // Pass 2: merge stretched video + audio (stream-copy video)
  await runFfmpeg([
    "-i", stretchedVid,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-t", String(audioDur),
    "-movflags", "+faststart",
    outputPath,
  ]);

  removeFiles(stretchedVid);
}

/** Build a slideshow from multiple images + one audio track.
 *  Each sub-image is encoded individually, then concatenated via the
 *  concat demuxer (no complex filters). Audio is added last. */
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

  // 1. Create a silent clip per sub-image
  const subClips: string[] = [];
  for (let j = 0; j < n; j++) {
    const imgPath = path.join(tempDir, `scene_${sceneIndex}_img${j}.png`);
    const subPath = path.join(tempDir, `scene_${sceneIndex}_sub${j}.mp4`);
    await streamToFile(imageUrls[j], imgPath);
    await imageToSilentClip(imgPath, subPath, perImgDur);
    removeFiles(imgPath);
    subClips.push(subPath);
  }

  // 2. Concatenate sub-clips via concat demuxer (no complex filter)
  const slideshowPath = path.join(tempDir, `scene_${sceneIndex}_slideshow.mp4`);
  await concatFiles(subClips, slideshowPath);
  removeFiles(...subClips);

  // 3. Add audio track
  await runFfmpeg([
    "-i", slideshowPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-t", String(audioDur),
    "-movflags", "+faststart",
    outputPath,
  ]);

  removeFiles(slideshowPath);
}

/** Process one scene → local MP4 (normalised). Returns null if nothing usable. */
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
      const actualDur = await imageAudioToClip(imgPath, audPath, localPath, tempDir, i);
      console.log(`[SceneEncoder] Scene ${i}: done (${actualDur.toFixed(1)}s from audio probe)`);
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
