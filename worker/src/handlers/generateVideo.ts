import { supabase } from "../lib/supabase.js";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import { v4 as uuidv4 } from "uuid";
import { extractScriptWithOpenRouter } from "../services/openrouter.js";
import { generateSpeechUrl } from "../services/elevenlabs.js";
import { generateImage, generateVideoFromImage } from "../services/hypereal.js";

// Helper to download a file from a URL to a local path
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.statusText}`);
  const buffer = await response.buffer();
  await fs.promises.writeFile(destPath, buffer);
}

// Helper to upload a local file to Supabase Storage
async function uploadToSupabase(localPath: string, fileName: string): Promise<string> {
  const fileBuffer = await fs.promises.readFile(localPath);
  
  const { data, error } = await supabase.storage
    .from('videos')
    .upload(`generated/${fileName}`, fileBuffer, {
      contentType: 'video/mp4',
      upsert: true
    });

  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  const { data: publicData } = supabase.storage.from('videos').getPublicUrl(`generated/${fileName}`);
  return publicData.publicUrl;
}

// Helper to merge video and audio using FFmpeg
function mergeAudioVideo(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .addInput(videoPath)
      .addInput(audioPath)
      .outputOptions([
        '-c:v copy',      // Copy video codec (no re-encoding)
        '-c:a aac',       // Encode audio to AAC
        '-map 0:v:0',     // Take video from first input
        '-map 1:a:0',     // Take audio from second input
        '-shortest'       // End when the shortest input ends
      ])
      .save(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`FFmpeg Error: ${err.message}`)));
  });
}

export async function handleGenerateVideo(jobId: string, payload: any) {
  console.log(`[GenerateVideo] Starting processing for job ${jobId}`);
  
  const { prompt, style, voice_id, project_id, generation_id } = payload;
  const tempDir = path.join(os.tmpdir(), `motionmax_${jobId}`);
  
  try {
    // 1. Setup Workspace
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    
    // Update progress
    await supabase.from('video_generation_jobs').update({ progress: 10, status: 'processing' }).eq('id', jobId);

    // 2. Extract Script
    // Using dummy values for API keys here; in production, these come from environment variables or the database
    const openRouterApiKey = process.env.OPENROUTER_API_KEY || "";
    const hyperealApiKey = process.env.HYPEREAL_API_KEY || "";
    const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || "";

    /* --- COMMENTED OUT ACTUAL API CALLS FOR SAFETY DURING SCAFFOLD ---
    const script = await extractScriptWithOpenRouter(prompt, style, 15, openRouterApiKey);
    const scene = script.scenes[0]; // Process first scene for now

    // 3. Generate Assets
    await supabase.from('video_generation_jobs').update({ progress: 30 }).eq('id', jobId);
    const audioUrl = await generateSpeechUrl(scene.narration, voice_id, elevenLabsApiKey);
    
    await supabase.from('video_generation_jobs').update({ progress: 50 }).eq('id', jobId);
    const imageUrl = await generateImage(scene.visual_prompt, hyperealApiKey, "16:9");
    const videoUrl = await generateVideoFromImage(imageUrl, scene.visual_prompt, hyperealApiKey);
    */

    // DUMMY URLS for scaffold testing
    const videoUrl = "https://raw.githubusercontent.com/bower-media-samples/big-buck-bunny-1080p-60fps-30s/master/video.mp4";
    const audioUrl = "https://raw.githubusercontent.com/mathiasbynens/small/master/mp3.mp3";

    // 4. Download Assets to Temp Disk
    console.log(`[GenerateVideo] Downloading assets to ${tempDir}`);
    await supabase.from('video_generation_jobs').update({ progress: 70 }).eq('id', jobId);
    
    const localVideoPath = path.join(tempDir, 'scene.mp4');
    const localAudioPath = path.join(tempDir, 'audio.mp3');
    const finalOutputPath = path.join(tempDir, 'final_output.mp4');

    await downloadFile(videoUrl, localVideoPath);
    await downloadFile(audioUrl, localAudioPath);

    // 5. Merge with FFmpeg
    console.log(`[GenerateVideo] Merging video and audio via FFmpeg...`);
    await supabase.from('video_generation_jobs').update({ progress: 85 }).eq('id', jobId);
    await mergeAudioVideo(localVideoPath, localAudioPath, finalOutputPath);

    // 6. Upload Result
    console.log(`[GenerateVideo] Uploading final video to Supabase Storage...`);
    const finalFileName = `${project_id}_${Date.now()}.mp4`;
    const finalVideoUrl = await uploadToSupabase(finalOutputPath, finalFileName);

    console.log(`[GenerateVideo] Job ${jobId} successfully completed. URL: ${finalVideoUrl}`);
    
    // 7. Update Records
    if (generation_id) {
        await supabase.from('generations').update({
            status: 'completed',
            video_url: finalVideoUrl,
            updated_at: new Date().toISOString()
        }).eq('id', generation_id);
    }

    return { success: true, url: finalVideoUrl };

  } catch (error) {
    console.error(`[GenerateVideo] Job ${jobId} failed:`, error);
    throw error;
  } finally {
    // 8. Cleanup Temp Files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log(`[GenerateVideo] Cleaned up temporary directory ${tempDir}`);
    }
  }
}