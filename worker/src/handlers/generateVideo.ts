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
    .upload(`generated/${fileName}`, fileBuffer, {
      contentType: 'video/mp4',
      upsert: true
    });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
  const { data: publicData } = supabase.storage.from('videos').getPublicUrl(`generated/${fileName}`);
  return publicData.publicUrl;
}

function mergeAudioVideo(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .addInput(videoPath)
      .addInput(audioPath)
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-map 0:v:0',
        '-map 1:a:0',
        '-shortest'
      ])
      .save(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`FFmpeg Error: ${err.message}`)));
  });
}

function sanitizePrompt(prompt: string): string {
    // 1. Remove systemic tags to prevent injection (like </system> or <role>)
    // 2. Escape special character chains commonly used for jailbreaking
    // 3. Limit length to prevent buffer bloat
    const stripped = prompt
        .replace(/<\/?(system|role|instruction|framework|rules)[^>]*>/gi, "")
        .replace(/(\n|\r)+/g, ' ')
        .substring(0, 5000)
        .trim();
    return stripped;
}

export async function handleGenerateVideo(jobId: string, payload: any, userId?: string) {
  // Client sends "content" (not "prompt"); also accept "prompt" as fallback
  const content = payload.content || payload.prompt || "";
  const { style, voice_id, voiceId, project_id, generation_id, format, length } = payload;
  const resolvedVoiceId = voice_id || voiceId;
  
  await writeSystemLog({ jobId, projectId: project_id, userId, generationId: generation_id, category: "system_info", eventType: "generate_video_started", message: `Started video generation for project ${project_id}`});
  
  console.log(`[GenerateVideo] Starting processing for job ${jobId}`, {
    contentLength: content.length,
    style,
    format,
    length,
  });
  const tempDir = path.join(os.tmpdir(), `motionmax_${jobId}`);
  
  try {
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    await supabase.from('video_generation_jobs').update({ progress: 10, status: 'processing' }).eq('id', jobId);

    const openRouterApiKey = process.env.OPENROUTER_API_KEY || "";
    const hyperealApiKey = process.env.HYPEREAL_API_KEY || "";
    const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || "";

    // Sanitize content before sending to LLM pipeline
    const cleanPrompt = sanitizePrompt(content);
    await writeSystemLog({ jobId, projectId: project_id, userId, generationId: generation_id, category: "system_info", eventType: "prompt_sanitized", message: `Sanitized prompt length: ${cleanPrompt.length} chars`});

    const targetDuration = length === "presentation" ? 480 : length === "brief" ? 225 : 90;
    const script = await extractScriptWithOpenRouter(cleanPrompt, style || "realistic", targetDuration, openRouterApiKey);
    const scene = script.scenes[0];

    if (!scene) {
      throw new Error("Script generation returned no scenes");
    }

    await supabase.from('video_generation_jobs').update({ progress: 30 }).eq('id', jobId);
    const audioUrl = await generateSpeechUrl(scene.narration, resolvedVoiceId, elevenLabsApiKey, project_id);

    await supabase.from('video_generation_jobs').update({ progress: 50 }).eq('id', jobId);
    const aspectRatio = format === "portrait" ? "9:16" : format === "square" ? "1:1" : "16:9";
    const imageUrl = await generateImage(scene.visual_prompt, hyperealApiKey, aspectRatio);
    const videoUrl = await generateVideoFromImage(imageUrl, scene.visual_prompt, hyperealApiKey);

    console.log(`[GenerateVideo] Downloading assets to ${tempDir}`);
    await writeSystemLog({ jobId, projectId: project_id, userId, generationId: generation_id, category: "system_info", eventType: "download_assets_started", message: `Downloading raw video and audio assets to Render node`});
    
    await supabase.from('video_generation_jobs').update({ progress: 70 }).eq('id', jobId);
    
    const localVideoPath = path.join(tempDir, 'scene.mp4');
    const localAudioPath = path.join(tempDir, 'audio.mp3');
    const finalOutputPath = path.join(tempDir, 'final_output.mp4');

    await downloadFile(videoUrl, localVideoPath);
    await downloadFile(audioUrl, localAudioPath);

    await writeSystemLog({ jobId, projectId: project_id, userId, generationId: generation_id, category: "system_info", eventType: "ffmpeg_merge_started", message: `Started FFmpeg compilation`});
    console.log(`[GenerateVideo] Merging video and audio via FFmpeg...`);
    await supabase.from('video_generation_jobs').update({ progress: 85 }).eq('id', jobId);
    await mergeAudioVideo(localVideoPath, localAudioPath, finalOutputPath);

    await writeSystemLog({ jobId, projectId: project_id, userId, generationId: generation_id, category: "system_info", eventType: "upload_started", message: `Uploading compiled video to Supabase Storage`});
    console.log(`[GenerateVideo] Uploading final video to Supabase Storage...`);
    const finalFileName = `${project_id}_${Date.now()}.mp4`;
    const finalVideoUrl = await uploadToSupabase(finalOutputPath, finalFileName);

    console.log(`[GenerateVideo] Job ${jobId} successfully completed. URL: ${finalVideoUrl}`);
    
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
    await writeSystemLog({ jobId, projectId: project_id, userId, generationId: generation_id, category: "system_error", eventType: "generate_video_failed", message: `Video generation explicitly failed`, details: { error: error instanceof Error ? error.message : "Unknown" }});
    throw error;
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log(`[GenerateVideo] Cleaned up directory ${tempDir}`);
    }
  }
}