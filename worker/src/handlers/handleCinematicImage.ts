import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { generateImage } from "../services/imageGenerator.js";

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
    .select("*, projects!inner(format, style)")
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

  const format = generation.projects?.format || "landscape";
  const hyperealApiKey = process.env.HYPEREAL_API_KEY || "";
  const replicateApiKey = process.env.REPLICATE_API_KEY || "";

  if (!hyperealApiKey && !replicateApiKey) {
    throw new Error("Neither HYPEREAL_API_KEY nor REPLICATE_API_KEY is configured");
  }

  const prompt = scene.visualPrompt || scene.visual_prompt || "Cinematic scene";

  const imageUrl = await generateImage(prompt, hyperealApiKey, replicateApiKey, format, projectId);

  if (!imageUrl) {
    throw new Error("Image generation failed");
  }

  scenes[sceneIndex].imageUrl = imageUrl;

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
    eventType: "cinematic_image_completed",
    message: `Cinematic image completed for scene ${sceneIndex}`,
  });

  return { success: true, status: "complete", sceneIndex, imageUrl };
}