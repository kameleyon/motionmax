import { supabase } from "../lib/supabase.js";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import ffmpeg from "fluent-ffmpeg";
import { writeSystemLog } from "../lib/logger.js";

const FFMPEG_TIMEOUT_SEC = 120; // 2 minutes per FFmpeg operation

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

  // Use Supabase Storage REST directly with a stream body to avoid buffering
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;
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
  });

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

/** Create a silent video from a still image (with timeout) */
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

/** Stitch scene MP4s using FFmpeg concat demuxer (with timeout) */
function concatVideos(fileListPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(fileListPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions('-c copy')
      .save(outputPath)
      .on('end', () => { clearTimeout(timer); resolve(); })
      .on('error', (err) => { clearTimeout(timer); reject(err); });

    const timer = setTimeout(() => {
      cmd.kill('SIGKILL');
      reject(new Error(`FFmpeg concat timed out after ${FFMPEG_TIMEOUT_SEC}s`));
    }, FFMPEG_TIMEOUT_SEC * 1000);
  });
}

export async function handleExportVideo(jobId: string, payload: any, userId?: string) {
  const { scenes, format, brandMark, project_id } = payload;
  
  await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_info", eventType: "export_video_started", message: `Started video stitching for ${scenes.length} scenes`});
  
  console.log(`[ExportVideo] Starting processing for job ${jobId}`);
  const tempDir = path.join(os.tmpdir(), `motionmax_export_${jobId}`);
  const fileListPath = path.join(tempDir, 'files.txt');
  const finalOutputPath = path.join(tempDir, 'final_export.mp4');
  
  try {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    await supabase.from('video_generation_jobs').update({ progress: 10, status: 'processing' }).eq('id', jobId);

    // 1. Download/create scene MP4s one at a time, clean up source files after each
    const downloadedFiles: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const localPath = path.join(tempDir, `scene_${i}.mp4`);

      await supabase.from('video_generation_jobs').update({ progress: Math.floor(10 + (i / scenes.length) * 40) }).eq('id', jobId);

      if (scene.videoUrl) {
        console.log(`[ExportVideo] Streaming scene ${i} video to disk`);
        await streamToFile(scene.videoUrl, localPath);
        downloadedFiles.push(localPath);
      } else if (scene.imageUrl && scene.audioUrl) {
        const imgPath = path.join(tempDir, `scene_${i}_img.png`);
        const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
        console.log(`[ExportVideo] Scene ${i}: streaming image + audio, then FFmpeg`);
        await streamToFile(scene.imageUrl, imgPath);
        await streamToFile(scene.audioUrl, audPath);
        const duration = scene.duration || 10;
        await createVideoFromImageAudio(imgPath, audPath, localPath, duration);
        // Free source files immediately after FFmpeg produces the MP4
        removeFiles(imgPath, audPath);
        downloadedFiles.push(localPath);
        console.log(`[ExportVideo] Scene ${i}: done (${duration}s)`);
      } else if (scene.imageUrl) {
        const imgPath = path.join(tempDir, `scene_${i}_img.png`);
        console.log(`[ExportVideo] Scene ${i}: streaming image, then silent FFmpeg`);
        await streamToFile(scene.imageUrl, imgPath);
        const duration = scene.duration || 5;
        await createSilentVideo(imgPath, localPath, duration);
        removeFiles(imgPath);
        downloadedFiles.push(localPath);
      } else {
        console.warn(`[ExportVideo] Scene ${i}: no videoUrl, imageUrl, or audioUrl — skipping`);
      }
    }

    if (downloadedFiles.length === 0) throw new Error("No video scenes provided to stitch.");

    await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_info", eventType: "export_download_complete", message: `Created ${downloadedFiles.length} scene videos`});
    await supabase.from('video_generation_jobs').update({ progress: 60 }).eq('id', jobId);

    // 2. Stitch using FFmpeg concat demuxer
    const fileContent = downloadedFiles.map(file => `file '${file.replace(/\\/g, '/')}'`).join('\n');
    await fs.promises.writeFile(fileListPath, fileContent);

    await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_info", eventType: "ffmpeg_stitch_started", message: `Starting FFmpeg concat`});
    await concatVideos(fileListPath, finalOutputPath);

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
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
