import { supabase } from "../lib/supabase.js";

import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import ffmpeg from "fluent-ffmpeg";
import { writeSystemLog } from "../lib/logger.js";

const FFMPEG_TIMEOUT_SEC = 120; // 2 minutes per FFmpeg operation
const SCENE_BATCH_SIZE = 4;     // scenes processed in parallel (I/O bound downloads)

/** Memory-safe x264 flags — keeps libx264 under ~40MB by using 1 thread + minimal buffers */
const X264_MEM_FLAGS = [
  '-threads 1',
  '-refs 1',
  '-rc-lookahead 0',
  '-g 24',
  '-bf 0',
  '-x264-params rc-lookahead=0:threads=1',
];

/** Stream a URL directly to disk without buffering in Node.js heap */
async function streamToFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.statusText}`);
  if (!response.body) throw new Error(`No response body for ${url}`);
  const dest = fs.createWriteStream(destPath);
  await pipeline(response.body, dest);
}

const BUCKET_NAME = 'videos';

/** Upload final MP4 to Supabase Storage using streaming REST to avoid loading into heap */
async function uploadToSupabase(localPath: string, fileName: string): Promise<string> {
  const stat = await fs.promises.stat(localPath);
  const stream = fs.createReadStream(localPath);

  // Use validated Supabase URL from shared module (handles project migration)
  const { WORKER_SUPABASE_URL: supabaseUrl, WORKER_SUPABASE_KEY: supabaseKey } = await import("../lib/supabase.js");
  const storagePath = `exports/${fileName}`;

  const uploadUrl = `${supabaseUrl}/storage/v1/object/${BUCKET_NAME}/${storagePath}`;
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${supabaseKey}`,
      'apikey': supabaseKey,
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
      'x-upsert': 'true',
    },
    body: stream as any,
    // Required in Node.js 18+ when sending a streaming body via fetch()
    duplex: 'half',
  } as any);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Supabase upload failed (${response.status}): ${errText}`);
  }

  const { data: publicData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);
  return publicData.publicUrl;
}

/** Delete files silently (cleanup helper) */
function removeFiles(...paths: string[]) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

/** Create a video from a still image + audio using FFmpeg (with timeout) */
function createVideoFromImageAudio(
  imagePath: string,
  audioPath: string,
  outputPath: string,
  duration: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .addInput(imagePath)
      .inputOptions(['-loop 1', '-framerate 24'])
      .addInput(audioPath)
      .videoFilters('scale=trunc(iw/2)*2:trunc(ih/2)*2')
      .outputOptions([
        '-c:v libx264',
        '-preset ultrafast',
        '-tune stillimage',
        '-c:a aac',
        '-b:a 128k',
        '-pix_fmt yuv420p',
        '-shortest',
        `-t ${Math.ceil(duration)}`,
        '-movflags +faststart',
        ...X264_MEM_FLAGS,
      ])
      .save(outputPath)
      .on('end', () => { clearTimeout(timer); resolve(); })
      .on('error', (err) => { clearTimeout(timer); reject(new Error(`FFmpeg image→video: ${err.message}`)); });

    const timer = setTimeout(() => {
      cmd.kill('SIGKILL');
      reject(new Error(`FFmpeg image→video timed out after ${FFMPEG_TIMEOUT_SEC}s`));
    }, FFMPEG_TIMEOUT_SEC * 1000);
  });
}

/** Create a silent (video-only) clip from a still image */
function createSilentVideo(
  imagePath: string,
  outputPath: string,
  duration: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .addInput(imagePath)
      .inputOptions(['-loop 1', '-framerate 24'])
      .videoFilters('scale=trunc(iw/2)*2:trunc(ih/2)*2')
      .outputOptions([
        '-c:v libx264',
        '-preset ultrafast',
        '-tune stillimage',
        '-pix_fmt yuv420p',
        `-t ${duration}`,
        '-movflags +faststart',
        ...X264_MEM_FLAGS,
      ])
      .save(outputPath)
      .on('end', () => { clearTimeout(timer); resolve(); })
      .on('error', (err) => { clearTimeout(timer); reject(new Error(`FFmpeg silent: ${err.message}`)); });

    const timer = setTimeout(() => {
      cmd.kill('SIGKILL');
      reject(new Error(`FFmpeg silent-video timed out after ${FFMPEG_TIMEOUT_SEC}s`));
    }, FFMPEG_TIMEOUT_SEC * 1000);
  });
}

/** Probe media duration in seconds via ffprobe */
function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(new Error(`ffprobe: ${err.message}`));
      const dur = metadata?.format?.duration;
      resolve(typeof dur === 'number' && dur > 0 ? dur : 10);
    });
  });
}

/** Mux video + voice-over: slow-mo the video to exactly match audio duration per scene */
async function muxVideoAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<void> {
  const [videoDur, audioDur] = await Promise.all([
    probeDuration(videoPath),
    probeDuration(audioPath),
  ]);

  const ratio = audioDur / videoDur;
  console.log(`[ExportVideo] Video: ${videoDur.toFixed(1)}s | Audio: ${audioDur.toFixed(1)}s | Slowmo: ${ratio.toFixed(2)}x`);

  const filters = [
    `setpts=${ratio.toFixed(4)}*PTS`,
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  ].join(',');

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .addInput(videoPath)
      .addInput(audioPath)
      .videoFilters(filters)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        '-c:v libx264',
        '-preset ultrafast',
        '-pix_fmt yuv420p',
        '-c:a aac',
        '-b:a 128k',
        `-t ${audioDur}`,
        '-movflags +faststart',
        ...X264_MEM_FLAGS,
      ])
      .save(outputPath)
      .on('end', () => { clearTimeout(timer); resolve(); })
      .on('error', (err) => { clearTimeout(timer); reject(new Error(`FFmpeg mux: ${err.message}`)); });

    const timer = setTimeout(() => {
      cmd.kill('SIGKILL');
      reject(new Error(`FFmpeg mux timed out after ${FFMPEG_TIMEOUT_SEC}s`));
    }, FFMPEG_TIMEOUT_SEC * 1000);
  });
}

const TRANSITION_DURATION = 0.3; // seconds — fast cut

/** Pick a single consistent transition for the whole project */
function pickTransition(projectType?: string): string {
  if (projectType === 'cinematic' || projectType === 'storytelling') return 'fade';
  return 'slideup'; // doc2video, smartflow, default
}

/** Stitch scene MP4s with a consistent xfade transition between each clip */
async function concatWithTransitions(files: string[], outputPath: string, projectType?: string): Promise<void> {
  if (files.length === 1) {
    await fs.promises.copyFile(files[0], outputPath);
    return;
  }

  const transition = pickTransition(projectType);
  const durations = await Promise.all(files.map(probeDuration));
  console.log(`[ExportVideo] Transition: ${transition} (${projectType ?? 'default'}), ${files.length} scenes`);

  // Build xfade chain for video + aconcat for audio
  let filterComplex = '';
  let prevVLabel = '[0:v]';
  let cumulativeOffset = 0;

  for (let i = 1; i < files.length; i++) {
    cumulativeOffset += durations[i - 1] - TRANSITION_DURATION;
    const outLabel = i === files.length - 1 ? '[vout]' : `[vx${i}]`;
    filterComplex += `${prevVLabel}[${i}:v]xfade=transition=${transition}:duration=${TRANSITION_DURATION}:offset=${cumulativeOffset.toFixed(3)}${outLabel};`;
    prevVLabel = outLabel;
  }

  const audioInputs = files.map((_, i) => `[${i}:a]`).join('');
  filterComplex += `${audioInputs}concat=n=${files.length}:v=0:a=1[aout]`;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    files.forEach(f => cmd.addInput(f));
    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        '-map [vout]',
        '-map [aout]',
        '-c:v libx264',
        '-preset ultrafast',
        '-pix_fmt yuv420p',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
        ...X264_MEM_FLAGS,
      ])
      .save(outputPath)
      .on('end', () => { clearTimeout(timer); resolve(); })
      .on('error', (err) => { clearTimeout(timer); reject(err); });

    const timer = setTimeout(() => {
      cmd.kill('SIGKILL');
      reject(new Error(`FFmpeg concat+transitions timed out after ${FFMPEG_TIMEOUT_SEC}s`));
    }, FFMPEG_TIMEOUT_SEC * 1000);
  });
}

const SLIDE_TRANSITION_DURATION = 0.3; // cross-fade between sub-images within a scene

/** Concat sub-image clips with a cross-fade transition — video only (audio added by replaceAudioTrack) */
async function concatImagesWithFade(files: string[], outputPath: string): Promise<void> {
  if (files.length === 1) {
    await fs.promises.copyFile(files[0], outputPath);
    return;
  }

  const durations = await Promise.all(files.map(probeDuration));

  let filterComplex = '';
  let prevLabel = '[0:v]';
  let cumulativeOffset = 0;

  for (let i = 1; i < files.length; i++) {
    cumulativeOffset += durations[i - 1] - SLIDE_TRANSITION_DURATION;
    const outLabel = i === files.length - 1 ? '[vout]' : `[sv${i}]`;
    filterComplex += `${prevLabel}[${i}:v]xfade=transition=fade:duration=${SLIDE_TRANSITION_DURATION}:offset=${cumulativeOffset.toFixed(3)}${outLabel};`;
    prevLabel = outLabel;
  }

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    files.forEach(f => cmd.addInput(f));
    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        '-map [vout]',
        '-c:v libx264',
        '-preset ultrafast',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        ...X264_MEM_FLAGS,
      ])
      .save(outputPath)
      .on('end', () => { clearTimeout(timer); resolve(); })
      .on('error', (err) => { clearTimeout(timer); reject(err); });

    const timer = setTimeout(() => {
      cmd.kill('SIGKILL');
      reject(new Error(`FFmpeg slideshow-fade timed out after ${FFMPEG_TIMEOUT_SEC}s`));
    }, FFMPEG_TIMEOUT_SEC * 1000);
  });
}

/** Replace audio track in a video without re-encoding video (exact duration) */
function replaceAudioTrack(videoPath: string, audioPath: string, outputPath: string, duration: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .addInput(videoPath)
      .addInput(audioPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        '-c:v copy',
        '-c:a aac',
        '-b:a 128k',
        `-t ${duration}`,
        '-movflags +faststart',
      ])
      .save(outputPath)
      .on('end', () => { clearTimeout(timer); resolve(); })
      .on('error', (err) => { clearTimeout(timer); reject(new Error(`FFmpeg replaceAudio: ${err.message}`)); });

    const timer = setTimeout(() => {
      cmd.kill('SIGKILL');
      reject(new Error(`FFmpeg replaceAudio timed out after ${FFMPEG_TIMEOUT_SEC}s`));
    }, FFMPEG_TIMEOUT_SEC * 1000);
  });
}

/** Process a single scene: download or encode to a local MP4 */
async function processScene(
  i: number,
  scene: any,
  tempDir: string
): Promise<{ index: number; path: string | null }> {
  const localPath = path.join(tempDir, `scene_${i}.mp4`);

  if (scene.videoUrl && scene.audioUrl) {
    const vidPath = path.join(tempDir, `scene_${i}_vid.mp4`);
    const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
    console.log(`[ExportVideo] Scene ${i}: video+audio → mux`);
    await streamToFile(scene.videoUrl, vidPath);
    await streamToFile(scene.audioUrl, audPath);
    await muxVideoAudio(vidPath, audPath, localPath);
    removeFiles(vidPath, audPath);
    return { index: i, path: localPath };
  } else if (scene.videoUrl) {
    console.log(`[ExportVideo] Scene ${i}: downloading video`);
    await streamToFile(scene.videoUrl, localPath);
    return { index: i, path: localPath };
  } else if (Array.isArray(scene.imageUrls) && scene.imageUrls.length > 1 && scene.audioUrl) {
    // Multi-image slideshow: show each sub-visual for equal time across full audio duration
    const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
    console.log(`[ExportVideo] Scene ${i}: ${scene.imageUrls.length} images+audio → slideshow`);
    await streamToFile(scene.audioUrl, audPath);
    const audioDur = await probeDuration(audPath);
    const n = scene.imageUrls.length;
    // Each clip must be slightly longer than audioDur/n so xfade overlaps sum correctly:
    // n * perImgDur - (n-1) * SLIDE_TRANSITION_DURATION = audioDur
    const perImgDur = (audioDur + (n - 1) * SLIDE_TRANSITION_DURATION) / n;

    const subVids: string[] = [];
    for (let j = 0; j < n; j++) {
      const imgPath = path.join(tempDir, `scene_${i}_img${j}.png`);
      const subVidPath = path.join(tempDir, `scene_${i}_sub${j}.mp4`);
      await streamToFile(scene.imageUrls[j], imgPath);
      await createSilentVideo(imgPath, subVidPath, perImgDur);
      removeFiles(imgPath);
      subVids.push(subVidPath);
    }

    const slideshowPath = path.join(tempDir, `scene_${i}_slideshow.mp4`);
    await concatImagesWithFade(subVids, slideshowPath);
    removeFiles(...subVids);

    await replaceAudioTrack(slideshowPath, audPath, localPath, audioDur);
    removeFiles(slideshowPath, audPath);
    console.log(`[ExportVideo] Scene ${i}: slideshow done (${audioDur.toFixed(1)}s, ${scene.imageUrls.length} images)`);
    return { index: i, path: localPath };

  } else if (scene.imageUrl && scene.audioUrl) {
    const imgPath = path.join(tempDir, `scene_${i}_img.png`);
    const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
    console.log(`[ExportVideo] Scene ${i}: image+audio → FFmpeg`);
    await streamToFile(scene.imageUrl, imgPath);
    await streamToFile(scene.audioUrl, audPath);
    const duration = scene.duration || 10;
    await createVideoFromImageAudio(imgPath, audPath, localPath, duration);
    removeFiles(imgPath, audPath);
    console.log(`[ExportVideo] Scene ${i}: done (${duration}s)`);
    return { index: i, path: localPath };
  } else if (scene.imageUrl) {
    const imgPath = path.join(tempDir, `scene_${i}_img.png`);
    console.log(`[ExportVideo] Scene ${i}: image → silent FFmpeg`);
    await streamToFile(scene.imageUrl, imgPath);
    const duration = scene.duration || 5;
    await createSilentVideo(imgPath, localPath, duration);
    removeFiles(imgPath);
    return { index: i, path: localPath };
  } else {
    console.warn(`[ExportVideo] Scene ${i}: no usable URL — skipping`);
    return { index: i, path: null };
  }
}

export async function handleExportVideo(jobId: string, payload: any, userId?: string) {
  const { scenes, format, brandMark, project_id, project_type } = payload;

  await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_info", eventType: "export_video_started", message: `Started video stitching for ${scenes.length} scenes` });

  console.log(`[ExportVideo] Starting processing for job ${jobId}`);
  const tempDir = path.join(os.tmpdir(), `motionmax_export_${jobId}`);
  const finalOutputPath = path.join(tempDir, 'final_export.mp4');

  try {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    await supabase.from('video_generation_jobs').update({ progress: 10, status: 'processing' }).eq('id', jobId);

    // 1. Download/encode scenes in parallel batches of SCENE_BATCH_SIZE.
    //    Order is preserved via indexed sceneResults array.
    //    Progress is updated once per batch (fewer DB writes).
    const sceneResults: (string | null)[] = new Array(scenes.length).fill(null);

    for (let batchStart = 0; batchStart < scenes.length; batchStart += SCENE_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + SCENE_BATCH_SIZE, scenes.length);
      const batchPromises = [];
      for (let i = batchStart; i < batchEnd; i++) {
        batchPromises.push(processScene(i, scenes[i], tempDir));
      }
      const batchResults = await Promise.allSettled(batchPromises);

      for (const result of batchResults) {
        if (result.status === "fulfilled" && result.value.path) {
          sceneResults[result.value.index] = result.value.path;
        } else if (result.status === "rejected") {
          console.error(`[ExportVideo] Scene in batch ${batchStart}-${batchEnd} failed:`, result.reason);
        }
      }

      // Progress 10–60% across all batches (1 DB write per batch, not per scene)
      const batchProgress = Math.floor(10 + (batchEnd / scenes.length) * 50);
      await supabase.from('video_generation_jobs').update({ progress: batchProgress }).eq('id', jobId);
      console.log(`[ExportVideo] Batch ${batchStart}-${batchEnd - 1} complete (${batchProgress}%)`);
    }

    const downloadedFiles = sceneResults.filter((p): p is string => p !== null);

    if (downloadedFiles.length === 0) throw new Error("No video scenes provided to stitch.");

    await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_info", eventType: "export_download_complete", message: `Created ${downloadedFiles.length} scene videos`});
    await supabase.from('video_generation_jobs').update({ progress: 60 }).eq('id', jobId);

    // 2. Stitch with xfade transitions
    await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_info", eventType: "ffmpeg_stitch_started", message: `Starting FFmpeg stitch with transitions`});
    await concatWithTransitions(downloadedFiles, finalOutputPath, project_type);

    // Free individual scene MP4s after concat produces the final file
    for (const f of downloadedFiles) removeFiles(f);

    await supabase.from('video_generation_jobs').update({ progress: 90 }).eq('id', jobId);

    // 3. Upload final video
    const finalFileName = `export_${project_id}_${Date.now()}.mp4`;
    const finalVideoUrl = await uploadToSupabase(finalOutputPath, finalFileName);

    await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_info", eventType: "export_video_completed", message: `Video stitched and exported successfully`});

    return { success: true, url: finalVideoUrl };
  } catch (error) {
    console.error(`[ExportVideo] Job ${jobId} failed:`, error);
    await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_error", eventType: "export_video_failed", message: `Video stitching failed`, details: { error: error instanceof Error ? error.message : "Unknown" }});
    throw error;
  } finally {
    // Cleanup temp dir — swallow errors (EBUSY on Windows when FFmpeg still holds handles)
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      console.warn(`[ExportVideo] Temp dir cleanup skipped for ${jobId}:`, (cleanupErr as Error).message);
    }
  }
}
