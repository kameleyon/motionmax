/**
 * Regenerate or edit a specific scene image via the worker queue.
 * task_type: "regenerate_image"
 *
 * Supports:
 *  - Full regeneration (empty imageModification) using the scene's visualPrompt
 *  - Guided edit (non-empty imageModification) injected into the prompt
 *  - Multi-image scenes via imageIndex (0=primary, 1=subVisuals[0], etc.)
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { generateImage } from "../services/imageGenerator.js";
import { getStylePrompt } from "../services/prompts.js";

// ── Types ──────────────────────────────────────────────────────────

interface RegenerateImagePayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  imageIndex?: number;
  imageModification?: string;
  [key: string]: unknown;
}

interface RegenerateImageResult {
  success: boolean;
  sceneIndex: number;
  imageIndex: number;
  imageUrl: string;
  imageUrls: (string | null)[];
}

// ── Handler ────────────────────────────────────────────────────────

export async function handleRegenerateImage(
  jobId: string,
  payload: RegenerateImagePayload,
  userId?: string,
): Promise<RegenerateImageResult> {
  const { generationId, projectId, sceneIndex } = payload;
  const targetImageIndex = typeof payload.imageIndex === "number" ? payload.imageIndex : 0;
  const imageModification = payload.imageModification || "";

  const hyperealApiKey = process.env.HYPEREAL_API_KEY || "";
  const replicateApiKey = process.env.REPLICATE_API_KEY || "";

  if (!hyperealApiKey && !replicateApiKey) {
    throw new Error("No image generation API key configured");
  }

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "regenerate_image_started",
    message: `Regenerating scene ${sceneIndex + 1} image ${targetImageIndex + 1}${imageModification ? " (edit)" : ""}`,
  });

  // Fetch generation + project style/format
  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("scenes, projects!inner(format, style)")
    .eq("id", generationId)
    .single();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const scenes: any[] = generation.scenes || [];
  if (sceneIndex < 0 || sceneIndex >= scenes.length) throw new Error("Invalid scene index");

  const scene = scenes[sceneIndex];
  const format: string = (generation.projects as any)?.format || "landscape";
  const style: string = (generation.projects as any)?.style || "realistic";
  const styleDesc = getStylePrompt(style);

  // Build prompt — select sub-visual for indices > 0
  let basePrompt: string = scene.visualPrompt || "";
  if (targetImageIndex > 0) {
    const subIdx = targetImageIndex - 1;
    const hasSubVisual = Array.isArray(scene.subVisuals) && scene.subVisuals[subIdx];
    basePrompt = hasSubVisual
      ? scene.subVisuals[subIdx]
      : (subIdx === 0 ? "close-up detail shot, " : "wide establishing shot, ") + scene.visualPrompt;
  }

  const fullPrompt = imageModification
    ? `${basePrompt}\n\nUSER MODIFICATION REQUEST: ${imageModification}\n\nSTYLE: ${styleDesc}\n\nApply the modification while maintaining scene consistency. Professional illustration.`
    : `${basePrompt}\n\nSTYLE: ${styleDesc}\n\nProfessional illustration with dynamic composition and clear visual hierarchy.`;

  // Generate image (uploads to scene-images bucket, returns public URL)
  const imageUrl = await generateImage(fullPrompt, hyperealApiKey, replicateApiKey, format, projectId);

  // Patch the scene's imageUrl / imageUrls array
  const existingUrls: (string | null)[] =
    Array.isArray(scene.imageUrls) && scene.imageUrls.length > 0
      ? [...scene.imageUrls]
      : scene.imageUrl ? [scene.imageUrl] : [];

  if (existingUrls.length > 0) {
    existingUrls[targetImageIndex] = imageUrl;
    scenes[sceneIndex].imageUrls = existingUrls;
    if (targetImageIndex === 0) scenes[sceneIndex].imageUrl = imageUrl;
  } else {
    scenes[sceneIndex].imageUrl = imageUrl;
    scenes[sceneIndex].imageUrls = [imageUrl];
  }

  await supabase.from("generations").update({ scenes }).eq("id", generationId);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "regenerate_image_completed",
    message: `Scene ${sceneIndex + 1} image ${targetImageIndex + 1} regenerated successfully`,
  });

  console.log(`[RegenerateImage] Scene ${sceneIndex + 1} img ${targetImageIndex + 1}: ${imageUrl.substring(0, 80)}`);

  return {
    success: true,
    sceneIndex,
    imageIndex: targetImageIndex,
    imageUrl,
    imageUrls: scenes[sceneIndex].imageUrls,
  };
}
