import { supabase } from "../lib/supabase.js";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import { v4 as uuidv4 } from "uuid";
import { writeSystemLog } from "../lib/logger.js";

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.statusText}`);
  const buffer = await response.buffer();
  await fs.promises.writeFile(destPath, buffer);
}

async function uploadToSupabase(localPath: string, fileName: string): Promise<string> {
  const fileBuffer = await fs.promises.readFile(localPath);
  const { data, error } = await supabase.storage
    .from('videos')
    .upload(`exports/${fileName}`, fileBuffer, {
      contentType: 'video/mp4',
      upsert: true
    });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  const { data: publicData } = supabase.storage.from('videos').getPublicUrl(`exports/${fileName}`);
  return publicData.publicUrl;
}

/** Create a video from a still image + audio using FFmpeg */
function createVideoFromImageAudio(
  imagePath: string,
  audioPath: string,
  outputPath: string,
  duration: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .addInput(imagePath)
      .inputOptions(['-loop 1', '-framerate 24'])
      .addInput(audioPath)
      .videoFilters('scale=trunc(iw/2)*2:trunc(ih/2)*2')
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-tune stillimage',
        '-c:a aac',
        '-b:a 192k',
        '-pix_fmt yuv420p',
        '-shortest',
        `-t ${Math.ceil(duration)}`,
        '-movflags +faststart',
      ])
      .save(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`FFmpeg image→video: ${err.message}`)));
  });
}

export async function handleExportVideo(jobId: string, payload: any, userId?: string) {
  const { scenes, format, brandMark, project_id } = payload;
  
  await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_info", eventType: "export_video_started", message: `Started video stitching for ${scenes.length} scenes`});
  
  console.log(`[ExportVideo] Starting processing for job ${jobId}`);
  const tempDir = path.join(os.tmpdir(), `motionmax_export_${jobId}`);
  let fileListPath = path.join(tempDir, 'files.txt');
  let finalOutputPath = path.join(tempDir, 'final_export.mp4');
  
  try {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    await supabase.from('video_generation_jobs').update({ progress: 10, status: 'processing' }).eq('id', jobId);

    // 1. Download/create scene MP4s (supports both video scenes and image+audio scenes)
    const downloadedFiles: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const localPath = path.join(tempDir, `scene_${i}.mp4`);

        await supabase.from('video_generation_jobs').update({ progress: Math.floor(10 + (i/scenes.length)*40) }).eq('id', jobId);

        if (scene.videoUrl) {
          // Cinematic: download pre-rendered video
          console.log(`[ExportVideo] Downloading scene ${i} video from ${scene.videoUrl}`);
          await downloadFile(scene.videoUrl, localPath);
          downloadedFiles.push(localPath);
        } else if (scene.imageUrl && scene.audioUrl) {
          // Standard: create video from image + audio
          const imgPath = path.join(tempDir, `scene_${i}_img.png`);
          const audPath = path.join(tempDir, `scene_${i}_aud.mp3`);
          console.log(`[ExportVideo] Scene ${i}: creating video from image + audio`);
          await downloadFile(scene.imageUrl, imgPath);
          await downloadFile(scene.audioUrl, audPath);
          const duration = scene.duration || 10;
          await createVideoFromImageAudio(imgPath, audPath, localPath, duration);
          downloadedFiles.push(localPath);
          console.log(`[ExportVideo] Scene ${i}: image→video created (${duration}s)`);
        } else if (scene.imageUrl) {
          // Image only (no audio): create silent video
          const imgPath = path.join(tempDir, `scene_${i}_img.png`);
          console.log(`[ExportVideo] Scene ${i}: creating silent video from image`);
          await downloadFile(scene.imageUrl, imgPath);
          const duration = scene.duration || 5;
          await new Promise<void>((resolve, reject) => {
            ffmpeg()
              .addInput(imgPath)
              .inputOptions(['-loop 1', '-framerate 24'])
              .videoFilters('scale=trunc(iw/2)*2:trunc(ih/2)*2')
              .outputOptions(['-c:v libx264', '-preset fast', '-tune stillimage', '-pix_fmt yuv420p', `-t ${duration}`, '-movflags +faststart'])
              .save(localPath)
              .on('end', () => resolve())
              .on('error', (err) => reject(new Error(`FFmpeg silent: ${err.message}`)));
          });
          downloadedFiles.push(localPath);
        } else {
          console.warn(`[ExportVideo] Scene ${i}: no videoUrl, imageUrl, or audioUrl — skipping`);
        }
    }

    if (downloadedFiles.length === 0) throw new Error("No video scenes provided to stitch.");

    await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_info", eventType: "export_download_complete", message: `Downloaded ${downloadedFiles.length} scene videos successfully`});
    await supabase.from('video_generation_jobs').update({ progress: 60 }).eq('id', jobId);

    // 2. Stitch using FFmpeg concat demuxer
    let fileContent = downloadedFiles.map(file => `file '${file.replace(/\\/g, '/')}'`).join('\n');
    await fs.promises.writeFile(fileListPath, fileContent);

    await writeSystemLog({ jobId, projectId: project_id, userId, category: "system_info", eventType: "ffmpeg_stitch_started", message: `Starting FFmpeg concat`});
    
    await new Promise<void>((resolve: () => void, reject) => {
        ffmpeg()
          .input(fileListPath)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions('-c copy')
          .save(finalOutputPath)
          .on('end', resolve)
          .on('error', (err) => reject(err));
    });

    await supabase.from('video_generation_jobs').update({ progress: 90 }).eq('id', jobId);

    // 3. Upload Result Sandbox
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
