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

    // 1. Download all scene MP4s
    const downloadedFiles: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        if (!scene.videoUrl) continue;

        await supabase.from('video_generation_jobs').update({ progress: Math.floor(10 + (i/scenes.length)*40) }).eq('id', jobId);
        
        const localPath = path.join(tempDir, `scene_${i}.mp4`);
        console.log(`[ExportVideo] Downloading scene ${i} from ${scene.videoUrl}`);
        await downloadFile(scene.videoUrl, localPath);
        downloadedFiles.push(localPath);
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
