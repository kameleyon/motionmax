import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateImage } from "../services/imageGenerator.js";
import { buildImagePrompt, type Scene as ImageScene } from "../services/imagePromptBuilder.js";
import {
  initSceneProgress,
  updateSceneProgress,
  flushSceneProgress,
  clearSceneProgress,
} from "../lib/sceneProgress.js";

interface CinematicImagePayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
}

export async function handleCinematicImage(
  jobId: string,
  payload: CinematicImagePayload,
  userId?: string
) {
  const { generationId, projectId, sceneIndex } = payload;

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "cinematic_image_started",
    message: `Cinematic image started for scene ${sceneIndex}`,
  });

  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("*, projects(format, style, character_description, character_consistency_enabled, project_type, character_images)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) {
    throw new Error(`Generation not found: ${genError?.message}`);
  }

  const scenes = generation.scenes as any[];
  const scene = scenes[sceneIndex];

  if (!scene) {
    throw new Error(`Scene ${sceneIndex} not found`);
  }

  const format = generation.projects?.format || "landscape";
  const style = generation.projects?.style || "realistic";
  const characterImages: string[] = (generation.projects as any)?.character_images || [];
  const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();

  if (!hyperealApiKey && !replicateApiKey) {
    throw new Error("Neither HYPEREAL_API_KEY nor REPLICATE_API_KEY is configured");
  }

  // Build the full image prompt with character bible, style, and format — same as other pipelines
  // Character bible is stored in scene _meta (set during script generation)
  const characterBible: Record<string, string> = scene._meta?.characterBible || scenes[0]?._meta?.characterBible || {};
  const characterDescription: string = generation.projects?.character_description || "";
  const rawVisual = scene.visualPrompt || scene.visual_prompt || "Cinematic scene";

  const prompt = buildImagePrompt(
    rawVisual,
    scene as ImageScene,
    0, // subIndex
    sceneIndex,
    {
      format,
      style,
      characterBible,
      characterDescription,
      isSmartFlow: generation.projects?.project_type === "smartflow",
    },
  );

  // Initialize per-scene progress (single scene for cinematic per-scene jobs)
  initSceneProgress(jobId, scenes.length, "cinematic_image");
  await updateSceneProgress(jobId, sceneIndex, "generating", {
    message: `Generating cinematic image for scene ${sceneIndex + 1}`,
  });

  const imageUrl = await generateImage(
    prompt, hyperealApiKey, replicateApiKey, format, projectId,
    characterImages.length > 0 ? characterImages : undefined,
  );

  if (!imageUrl) {
    await updateSceneProgress(jobId, sceneIndex, "failed", {
      message: `Scene ${sceneIndex + 1} image generation failed`,
      error: "Image generation returned no URL",
    });
    clearSceneProgress(jobId);
    throw new Error("Image generation failed");
  }

  // Atomic update: only set this scene's imageUrl without overwriting other scenes
  await updateSceneField(generationId, sceneIndex, "imageUrl", imageUrl);

  await updateSceneProgress(jobId, sceneIndex, "complete", {
    message: `Scene ${sceneIndex + 1} cinematic image complete`,
  });
  clearSceneProgress(jobId);

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "cinematic_image_completed",
    message: `Cinematic image completed for scene ${sceneIndex}`,
  });

  return { success: true, status: "complete", sceneIndex, imageUrl };
}
