/**
 * Encode a single scene into a normalised MP4 clip.
 *
 * Key strategy to prevent audio clipping:
 *   1. Transcode raw MP3 → AAC M4A (fixes VBR duration inaccuracy)
 *   2. Get exact duration via full decode (getExactAudioDuration)
 *   3. Create video LONGER than needed (exact + 3s buffer)
 *   4. Merge without -shortest or -t cap — audio is NEVER trimmed
 *   5. Trim final clip to exact audio length in a separate pass
 */
import path from "path";
import { runFfmpeg, getExactAudioDuration, X264_MEM_FLAGS } from "./ffmpegCmd.js";
import { streamToFile, removeFiles } from "./storageHelpers.js";
import { concatFiles } from "./concatScenes.js";

/** Shared video filter: ensure even dimensions for yuv420p */
const SCALE_EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

/** Transcode any audio (MP3/WAV/OGG) → AAC M4A with accurate duration.
 *  TTS MP3 files often have wrong VBR headers; transcoding fixes this. */
async function transcodeToAac(
  inputPath: string,
  outputPath: string
): Promise<void> {
  await runFfmpeg([
    "-i", inputPath,
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    outputPath,
  ]);
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

/** Create a video clip from a still image + audio file.
 *
 *  3-pass bulletproof approach:
 *    1. Transcode audio → AAC M4A (fixes VBR issues)
 *    2. Create silent video LONGER than audio (exact + 3s)
 *    3. Merge and trim to exact audio duration via re-encode
 */
async function imageAudioToClip(
  imagePath: string,
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number
): Promise<number> {
  // Step 1: Transcode audio → AAC M4A
  const aacPath = path.join(tempDir, `scene_${sceneIndex}_aac.m4a`);
  await transcodeToAac(audioPath, aacPath);

  // Step 2: Get exact audio duration via full decode
  const exactDur = await getExactAudioDuration(aacPath);
  console.log(`[SceneEncoder] Scene ${sceneIndex} imageAudio: exactAudio=${exactDur.toFixed(2)}s`);

  // Step 3: Create silent video at exact audio duration
  const silentVidPath = path.join(tempDir, `scene_${sceneIndex}_imgvid.mp4`);
  await imageToSilentClip(imagePath, silentVidPath, exactDur);

  // Step 4: Merge video + audio (no padding — exact decoded duration)
  await runFfmpeg([
    "-i", silentVidPath,
    "-i", aacPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    ...X264_MEM_FLAGS,
    outputPath,
  ]);

  removeFiles(silentVidPath, aacPath);
  return exactDur;
}

/** Mux video + audio: stretch video speed to match audio duration.
 *  Uses exact decoded audio duration to prevent clipping. */
async function muxVideoAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number
): Promise<void> {
  // Transcode audio → AAC M4A for accurate duration
  const aacPath = path.join(tempDir, `scene_${sceneIndex}_mux_aac.m4a`);
  await transcodeToAac(audioPath, aacPath);

  const [videoDur, audioDur] = await Promise.all([
    getExactAudioDuration(videoPath),
    getExactAudioDuration(aacPath),
  ]);
  const ratio = audioDur / videoDur;
  console.log(
    `[SceneEncoder] Scene ${sceneIndex} mux: video=${videoDur.toFixed(1)}s audio=${audioDur.toFixed(1)}s ratio=${ratio.toFixed(2)}x`
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

  // Pass 2: merge stretched video + audio (no padding — exact duration)
  await runFfmpeg([
    "-i", stretchedVid,
    "-i", aacPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ]);

  removeFiles(stretchedVid, aacPath);
}

/** Build a slideshow from multiple images + one audio track. */
async function slideshowFromImages(
  imageUrls: string[],
  audioPath: string,
  outputPath: string,
  tempDir: string,
  sceneIndex: number
): Promise<void> {
  // Transcode audio first for accurate duration
  const aacPath = path.join(tempDir, `scene_${sceneIndex}_slide_aac.m4a`);
  await transcodeToAac(audioPath, aacPath);
  const audioDur = await getExactAudioDuration(aacPath);

  const n = imageUrls.length;
  const perImgDur = audioDur / n; // exact split — no padding

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

  // 2. Concatenate sub-clips
  const slideshowPath = path.join(tempDir, `scene_${sceneIndex}_slideshow.mp4`);
  await concatFiles(subClips, slideshowPath, true); // streamCopy=true: identical codec sub-clips
  removeFiles(...subClips);

  // 3. Add audio track (no padding — exact audio duration)
  await runFfmpeg([
    "-i", slideshowPath,
    "-i", aacPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputPath,
  ]);

  removeFiles(slideshowPath, aacPath);
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
      console.log(`[SceneEncoder] Scene ${i}: done (${dur.toFixed(1)}s exact decode)`);
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
