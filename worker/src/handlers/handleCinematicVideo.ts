import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";

interface CinematicVideoPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  regenerate?: boolean;
}

export async function handleCinematicVideo(
  jobId: string,
  payload: CinematicVideoPayload,
  userId?: string
) {
  const { generationId, projectId, sceneIndex, regenerate } = payload;

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "cinematic_video_started",
    message: `Cinematic video started for scene ${sceneIndex}`,
  });

  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("scenes")
    .eq("id", generationId)
    .single();

  if (genError || !generation) {
    throw new Error(`Generation not found: ${genError?.message}`);
  }

  const scenes = generation.scenes as any[];
  const scene = scenes[sceneIndex];

  if (!scene) {
    throw new Error(`Scene ${sceneIndex} not found`);
  }

  const imageUrl = scene.imageUrl;
  if (!imageUrl) {
    throw new Error(`Scene ${sceneIndex} has no imageUrl`);
  }

  // Snapshot history for undo if regenerating
  if (regenerate) {
    const history = Array.isArray(scene._history) ? [...scene._history] : [];
    history.push({
      timestamp: new Date().toISOString(),
      videoUrl: scene.videoUrl,
    });
    if (history.length > 5) history.shift();
    scenes[sceneIndex]._history = history;
  }

  const hyperealApiKey = process.env.HYPEREAL_API_KEY;
  if (!hyperealApiKey) {
    throw new Error("HYPEREAL_API_KEY is not configured");
  }

  // Get format from project
  const { data: project } = await supabase
    .from("projects")
    .select("format")
    .eq("id", projectId)
    .single();
  
  const format = project?.format || "landscape";
  const aspectRatio = format === "portrait" ? "9:16" : format === "square" ? "1:1" : "16:9";

  const visualPrompt = scene.visualPrompt || scene.visual_prompt || scene.voiceover || "Cinematic scene with dramatic lighting";
  const videoPrompt = `${visualPrompt}

ANIMATION RULES (CRITICAL):
- NO lip-sync talking animation - characters should NOT move their mouths as if speaking
- Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry
- Body movement IS allowed: walking, running, gesturing, pointing, reacting
- Environment animation IS allowed: wind, particles, camera movement, lighting changes
- Static poses with subtle breathing/idle movement are preferred for dialogue scenes
- Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement`;

  // Start Hypereal Seedance 1.5 I2V job
  const startRes = await fetch("https://hypereal.tech/api/v1/videos/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${hyperealApiKey}`,
    },
    body: JSON.stringify({
      model: "seedance-1-5-i2v",
      input: {
        prompt: videoPrompt,
        image: imageUrl,
        duration: 5,
        resolution: "720p",
        aspect_ratio: aspectRatio,
      },
      generate_audio: false,
    }),
  });

  if (!startRes.ok) {
    const errText = await startRes.text();
    throw new Error(`Hypereal API error: ${startRes.status} ${errText}`);
  }

  const startData = await startRes.json();
  const hyperealJobId = startData.jobId || startData.id || startData.task_id || startData.prediction_id;

  if (!hyperealJobId) {
    throw new Error("Hypereal API did not return a job_id");
  }

  // Poll Hypereal API
  let videoUrl = null;
  const maxAttempts = 60; // 10 minutes at 10s intervals
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10000));

    const pollRes = await fetch(`https://hypereal.tech/api/v1/jobs/${hyperealJobId}?model=seedance-1-5-i2v&type=video`, {
      headers: {
        "Authorization": `Bearer ${hyperealApiKey}`,
      },
    });

    if (!pollRes.ok) {
      console.warn(`[CinematicVideo] Poll failed: ${pollRes.status}`);
      continue;
    }

    const pollData = await pollRes.json();
    const status = pollData.status;

    if (status === "completed" || status === "succeeded") {
      videoUrl = pollData.outputUrl || pollData.output_url || pollData.url;
      break;
    } else if (status === "failed") {
      throw new Error(`Hypereal job failed: ${pollData.error || "Unknown error"}`);
    }
  }

  if (!videoUrl) {
    throw new Error("Hypereal job timed out");
  }

  // Download and upload to Supabase
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) {
    throw new Error(`Failed to download video from Hypereal: ${videoRes.status}`);
  }

  const videoBuffer = await videoRes.arrayBuffer();
  const fileName = `${projectId}/${generationId}/scene_${sceneIndex}_${Date.now()}.mp4`;

  const { error: uploadError } = await supabase.storage
    .from("scene-videos")
    .upload(fileName, videoBuffer, {
      contentType: "video/mp4",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload video to Supabase: ${uploadError.message}`);
  }

  const { data: publicUrlData } = supabase.storage
    .from("scene-videos")
    .getPublicUrl(fileName);

  const finalVideoUrl = publicUrlData.publicUrl;

  // Update DB
  scenes[sceneIndex].videoUrl = finalVideoUrl;

  await supabase
    .from("generations")
    .update({ scenes })
    .eq("id", generationId);

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "cinematic_video_completed",
    message: `Cinematic video completed for scene ${sceneIndex}`,
  });

  return { success: true, status: "complete", videoUrl: finalVideoUrl, sceneIndex };
}