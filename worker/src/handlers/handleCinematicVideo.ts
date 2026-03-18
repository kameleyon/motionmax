import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";

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

  // Snapshot history for undo if regenerating (single-job, no concurrency issue)
  if (regenerate) {
    const history = Array.isArray(scene._history) ? [...scene._history] : [];
    history.push({
      timestamp: new Date().toISOString(),
      videoUrl: scene.videoUrl,
    });
    if (history.length > 5) history.shift();
    scenes[sceneIndex]._history = history;

    await supabase
      .from("generations")
      .update({ scenes })
      .eq("id", generationId);
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

  const visualPrompt = scene.visualPrompt || scene.visual_prompt || scene.voiceover || "Cinematic scene with dramatic lighting";
  const videoPrompt = buildVideoPrompt(visualPrompt);

  // Start Hypereal Kling V2.6 Pro I2V job
  const hyperealJobId = await startHyperealJob(hyperealApiKey, videoPrompt, imageUrl);

  // Poll Hypereal API
  const videoUrl = await pollHyperealJob(hyperealApiKey, hyperealJobId);

  // Download and upload to Supabase
  const finalVideoUrl = await uploadVideoToStorage(videoUrl, projectId, generationId, sceneIndex);

  // Atomic update: only set this scene's videoUrl without overwriting other scenes
  await updateSceneField(generationId, sceneIndex, "videoUrl", finalVideoUrl);

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

// ── Helpers ─────────────────────────────────────────────────────────

function buildVideoPrompt(visualPrompt: string): string {
  return `${visualPrompt}

ANIMATION RULES (CRITICAL):
- NO lip-sync talking animation - characters should NOT move their mouths as if speaking
- Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry
- Body movement IS allowed: walking, running, gesturing, pointing, reacting
- Environment animation IS allowed: wind, particles, camera movement, lighting changes
- Static poses with subtle breathing/idle movement are preferred for dialogue scenes
- Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement`;
}

async function startHyperealJob(
  apiKey: string,
  prompt: string,
  imageUrl: string
): Promise<string> {
  const startRes = await fetch("https://hypereal.tech/api/v1/videos/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "kling-2-6-i2v-pro",
      input: {
        prompt,
        image: imageUrl,
        negative_prompt: "blurry, low quality, watermark",
        duration: 5,
        cfg_scale: 0.5,
        sound: false,
      },
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

  return hyperealJobId;
}

async function pollHyperealJob(apiKey: string, hyperealJobId: string): Promise<string> {
  const maxAttempts = 60; // 10 minutes at 10s intervals

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10000));

    const pollRes = await fetch(
      `https://hypereal.tech/api/v1/jobs/${hyperealJobId}?model=kling-2-6-i2v-pro&type=video`,
      { headers: { "Authorization": `Bearer ${apiKey}` } }
    );

    if (!pollRes.ok) {
      console.warn(`[CinematicVideo] Poll failed: ${pollRes.status}`);
      continue;
    }

    const pollData = await pollRes.json();
    const status = pollData.status;

    if (status === "completed" || status === "succeeded") {
      const videoUrl = pollData.outputUrl || pollData.output_url || pollData.url;
      if (!videoUrl) throw new Error("Hypereal returned completed but no URL");
      return videoUrl;
    } else if (status === "failed") {
      throw new Error(`Hypereal job failed: ${pollData.error || "Unknown error"}`);
    }
  }

  throw new Error("Hypereal job timed out");
}

async function uploadVideoToStorage(
  videoUrl: string,
  projectId: string,
  generationId: string,
  sceneIndex: number
): Promise<string> {
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

  return publicUrlData.publicUrl;
}
