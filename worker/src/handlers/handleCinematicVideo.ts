/**
 * Cinematic video handler.
 *
 * Generates a 10s video per scene using Kling I2V with seamless morphing:
 *   - image = Scene N's generated image (start frame)
 *   - end_image = Scene N+1's generated image (end frame / morph target)
 *   - prompt = Scene N's video motion + camera motion + morph instruction
 *
 * Each clip IS both the scene AND the transition to the next scene.
 * During export, clips are concatenated directly — no separate transition step.
 * Audio is muxed on top during export.
 *
 * Provider chain:
 *   Primary:  Kling V3.0 Std I2V (kling-3-0-std-i2v)
 *   Fallback: Kling V2.6 Pro I2V (kling-2-6-i2v-pro)
 *   // Grok — commented out (replaced by Kling for native end_image support)
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateImage } from "../services/imageGenerator.js";
import {
  generateKlingV3Video,
  generateKlingV26Video,
  // generateGrokVideo — commented out: replaced by Kling for seamless morphing
} from "../services/hypereal.js";

// ── Types ──────────────────────────────────────────────────────────

interface CinematicVideoPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  regenerate?: boolean;
}

// ── Main handler ───────────────────────────────────────────────────

export async function handleCinematicVideo(
  jobId: string,
  payload: CinematicVideoPayload,
  userId?: string,
) {
  const { generationId, projectId, sceneIndex, regenerate } = payload;

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_video_started",
    message: `Cinematic video started for scene ${sceneIndex}`,
  });

  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("scenes")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) {
    throw new Error(`Generation not found: ${genError?.message}`);
  }

  const scenes = generation.scenes as any[];
  const scene = scenes[sceneIndex];
  if (!scene) throw new Error(`Scene ${sceneIndex} not found`);

  let imageUrl = scene.imageUrl;

  // Auto-generate image if missing
  if (!imageUrl) {
    console.log(`[CinematicVideo] Scene ${sceneIndex} has no imageUrl — generating image first`);
    const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
    const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
    const prompt = scene.visualPrompt || scene.visual_prompt || "Cinematic scene";

    const { data: proj } = await supabase.from("projects").select("format").eq("id", projectId).single();
    const fmt = proj?.format || "landscape";

    imageUrl = await generateImage(prompt, hyperealApiKey, replicateApiKey, fmt, projectId);
    await updateSceneField(generationId, sceneIndex, "imageUrl", imageUrl);
    console.log(`[CinematicVideo] Scene ${sceneIndex} image auto-generated`);
  }

  // Snapshot the imageUrl used — for stale-image guard later
  const sourceImageUrl = imageUrl;

  // Snapshot history for undo if regenerating
  if (regenerate) {
    const history = Array.isArray(scene._history) ? [...scene._history] : [];
    history.push({ timestamp: new Date().toISOString(), videoUrl: scene.videoUrl });
    if (history.length > 5) history.shift();
    scenes[sceneIndex]._history = history;
    await supabase.from("generations").update({ scenes }).eq("id", generationId);
  }

  // Get format from project
  const { data: project } = await supabase
    .from("projects")
    .select("format")
    .eq("id", projectId)
    .single();

  const format = project?.format || "landscape";

  // ── Get next scene's image for end_image (morph target) ──────────
  const nextScene = scenes[sceneIndex + 1];
  const nextImageUrl = nextScene?.imageUrl || null;
  const isLastScene = sceneIndex >= scenes.length - 1;

  if (nextImageUrl) {
    console.log(`[CinematicVideo] Scene ${sceneIndex}: will morph into scene ${sceneIndex + 1}`);
  } else if (!isLastScene) {
    console.log(`[CinematicVideo] Scene ${sceneIndex}: next scene has no image — no morph target`);
  } else {
    console.log(`[CinematicVideo] Scene ${sceneIndex}: last scene — no morph target`);
  }

  // ── Build prompt ─────────────────────────────────────────────────
  const visualPrompt = scene.visualPrompt || scene.visual_prompt || scene.voiceover || "Cinematic scene with dramatic lighting";
  const videoPrompt = buildVideoPrompt(visualPrompt, nextImageUrl ? true : false);

  const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  if (!hyperealApiKey) {
    throw new Error("HYPEREAL_API_KEY is not configured");
  }

  // ── Generate video: Kling V3.0 → Kling V2.6 fallback ────────────
  let finalVideoUrl: string | null = null;
  let provider = "";

  // Primary: Kling V3.0
  try {
    console.log(`[CinematicVideo] Scene ${sceneIndex}: trying Kling V3.0...`);
    const url = await generateKlingV3Video(
      imageUrl,
      videoPrompt,
      hyperealApiKey,
      10, // 10 seconds
      nextImageUrl || undefined,
    );
    if (url) {
      provider = "Kling V3.0";
      finalVideoUrl = await uploadVideoToStorage(url, projectId, generationId, sceneIndex);
      console.log(`[CinematicVideo] Scene ${sceneIndex}: ✅ ${provider} succeeded`);
    }
  } catch (err: any) {
    console.warn(`[CinematicVideo] Scene ${sceneIndex}: ❌ Kling V3.0 failed — ${err?.message || err}`);
  }

  // Fallback: Kling V2.6
  if (!finalVideoUrl) {
    try {
      console.log(`[CinematicVideo] Scene ${sceneIndex}: trying Kling V2.6 fallback...`);
      const url = await generateKlingV26Video(
        imageUrl,
        videoPrompt,
        hyperealApiKey,
        10,
        nextImageUrl || undefined,
      );
      if (url) {
        provider = "Kling V2.6";
        finalVideoUrl = await uploadVideoToStorage(url, projectId, generationId, sceneIndex);
        console.log(`[CinematicVideo] Scene ${sceneIndex}: ✅ ${provider} succeeded`);
      }
    } catch (err: any) {
      console.warn(`[CinematicVideo] Scene ${sceneIndex}: ❌ Kling V2.6 failed — ${err?.message || err}`);
    }
  }

  // ── Grok fallback — commented out (replaced by Kling) ──────────
  // if (!finalVideoUrl) {
  //   const grokResult = await generateGrokVideo({ prompt: videoPrompt, imageUrl, format });
  //   if (grokResult.url) {
  //     finalVideoUrl = await uploadVideoToStorage(grokResult.url, projectId, generationId, sceneIndex);
  //     provider = grokResult.provider;
  //   }
  // }

  if (!finalVideoUrl) {
    throw new Error(`Video generation failed for scene ${sceneIndex}: both Kling V3.0 and V2.6 failed`);
  }

  // ── Stale-image guard ────────────────────────────────────────────
  const { data: freshGen } = await supabase
    .from("generations")
    .select("scenes")
    .eq("id", generationId)
    .maybeSingle();

  const freshScenes = (freshGen?.scenes as any[]) ?? [];
  const freshImageUrl = freshScenes[sceneIndex]?.imageUrl;

  if (freshImageUrl && freshImageUrl !== sourceImageUrl) {
    console.warn(
      `[CinematicVideo] Scene ${sceneIndex}: imageUrl changed while video was generating — discarding stale video`,
    );
    await writeSystemLog({
      jobId, projectId, userId, generationId,
      category: "system_info",
      eventType: "cinematic_video_stale_discarded",
      message: `Scene ${sceneIndex} video discarded — source image was regenerated during generation`,
    });
    return { success: true, status: "stale_discarded", videoUrl: null, sceneIndex };
  }

  // Atomic update: only set this scene's videoUrl
  await updateSceneField(generationId, sceneIndex, "videoUrl", finalVideoUrl);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_video_completed",
    message: `Cinematic video completed for scene ${sceneIndex} (${provider})`,
  });

  return { success: true, status: "complete", videoUrl: finalVideoUrl, sceneIndex, provider };
}

// ── Prompt builder ─────────────────────────────────────────────────

function buildVideoPrompt(visualPrompt: string, hasMorphTarget: boolean): string {
  const basePrompt = `${visualPrompt}

ANIMATION RULES (CRITICAL):
- NO lip-sync talking animation - characters should NOT move their mouths as if speaking
- Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry
- Body movement IS allowed: walking, running, gesturing, pointing, reacting
- Environment animation IS allowed: wind, particles, camera movement, lighting changes
- Static poses with subtle breathing/idle movement are preferred for dialogue scenes
- Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement`;

  if (hasMorphTarget) {
    return `${basePrompt}

TRANSITION (CRITICAL):
- The camera must be in constant forward motion throughout
- In the final 3-4 seconds, the environment must seamlessly morph, stretch, and melt into the provided ending frame
- This morphing must be fluid and continuous — no hard cuts, no fades to black
- The camera pushes past the foreground as objects dissolve and reshape into the next scene`;
  }

  return basePrompt;
}

// ── Storage upload ─────────────────────────────────────────────────

async function uploadVideoToStorage(
  videoUrl: string,
  projectId: string,
  generationId: string,
  sceneIndex: number,
): Promise<string> {
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`Failed to download video: ${videoRes.status}`);

  const videoBuffer = await videoRes.arrayBuffer();
  const fileName = `${projectId}/${generationId}/scene_${sceneIndex}_${Date.now()}.mp4`;

  const { error: uploadError } = await supabase.storage
    .from("scene-videos")
    .upload(fileName, videoBuffer, { contentType: "video/mp4", upsert: true });

  if (uploadError) throw new Error(`Failed to upload video: ${uploadError.message}`);

  const { data: publicUrlData } = supabase.storage
    .from("scene-videos")
    .getPublicUrl(fileName);

  return publicUrlData.publicUrl;
}
