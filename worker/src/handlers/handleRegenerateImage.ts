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
import { editImageWithNanoBanana } from "../services/nanoBananaEdit.js";
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

  const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();

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
    .select("scenes, projects(format, style)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const scenes: any[] = generation.scenes || [];
  if (sceneIndex < 0 || sceneIndex >= scenes.length) throw new Error("Invalid scene index");

  const scene = scenes[sceneIndex];
  const format: string = (generation.projects as any)?.format || "landscape";
  const style: string = (generation.projects as any)?.style || "realistic";
  const styleDesc = getStylePrompt(style);

  // Extract character bible from scene _meta (set during script generation)
  const characterBible: Record<string, string> = scene._meta?.characterBible || {};
  const bibleSummary = Object.entries(characterBible)
    .map(([name, desc]) => `${name}: ${desc}`)
    .join("\n");

  // Also get user's character description from project
  const { data: projectData } = await supabase
    .from("projects")
    .select("character_description")
    .eq("id", projectId)
    .single();
  const userCharDesc = projectData?.character_description || "";

  // Combined character consistency block
  const characterBlock = [
    userCharDesc,
    bibleSummary ? `CHARACTER BIBLE (MUST FOLLOW EXACTLY):\n${bibleSummary}` : "",
  ].filter(Boolean).join("\n\n");

  let imageUrl: string;

  const aspectMap: Record<string, string> = {
    landscape: "16:9", portrait: "9:16", square: "1:1",
  };
  const aspectRatio = aspectMap[format] || "16:9";

  if (imageModification) {
    // Edit via Hypereal Nano Banana Edit — keeps the image, applies text instruction
    const sourceImageUrl = (scene.imageUrls || [])[targetImageIndex] || scene.imageUrl;
    if (!sourceImageUrl) throw new Error("Cannot edit an image that does not exist.");

    if (!hyperealApiKey) throw new Error("HYPEREAL_API_KEY required for image editing");

    // Inject style and character info into the edit instruction
    const editInstruction = [
      imageModification,
      `STYLE: ${styleDesc}. Maintain this exact visual style.`,
      characterBlock ? `CHARACTER APPEARANCE: ${characterBlock.substring(0, 300)}. Keep characters IDENTICAL to their description.` : "",
    ].filter(Boolean).join("\n");

    imageUrl = await editImageWithNanoBanana(
      sourceImageUrl,
      editInstruction,
      hyperealApiKey,
      aspectRatio,
    );
  } else {
    // Full Regeneration — include style + character bible in prompt
    let basePrompt: string = scene.visualPrompt || "";
    if (targetImageIndex > 0) {
      const subIdx = targetImageIndex - 1;
      const hasSubVisual = Array.isArray(scene.subVisuals) && scene.subVisuals[subIdx];
      basePrompt = hasSubVisual
        ? scene.subVisuals[subIdx]
        : (subIdx === 0 ? "close-up detail shot, " : "wide establishing shot, ") + scene.visualPrompt;
    }

    const promptParts = [
      basePrompt,
      `STYLE: ${styleDesc}. Maintain this exact visual style throughout.`,
      characterBlock ? `CHARACTER CONSISTENCY (MANDATORY):\n${characterBlock.substring(0, 500)}\nCharacters MUST match this description EXACTLY — same hair, same clothes, same skin tone.` : "",
    ];

    const fullPrompt = promptParts.filter(Boolean).join("\n\n");
    imageUrl = await generateImage(fullPrompt, hyperealApiKey, replicateApiKey, format, projectId);
  }

  // Save current state as a version in scene_versions table
  await supabase.rpc("save_scene_version", {
    p_generation_id: generationId,
    p_scene_index: sceneIndex,
    p_voiceover: scene.voiceover || null,
    p_visual_prompt: scene.visualPrompt || null,
    p_image_url: scene.imageUrl || null,
    p_image_urls: scene.imageUrls ? JSON.stringify(scene.imageUrls) : null,
    p_audio_url: scene.audioUrl || null,
    p_duration: scene.duration || null,
    p_video_url: scene.videoUrl || null,
    p_change_type: "image",
  });

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

  // Clear the stale videoUrl — it was generated from the old image.
  // The export will use the new imageUrl + audioUrl to build the clip.
  // Use null (not undefined) so the key is explicitly set in the JSON column.
  if (scenes[sceneIndex].videoUrl) {
    console.log(`[RegenerateImage] Clearing stale videoUrl for scene ${sceneIndex + 1}`);
    scenes[sceneIndex].videoUrl = null;
    scenes[sceneIndex].videoPredictionId = null;
  }

  await supabase.from("generations").update({ scenes }).eq("id", generationId);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "regenerate_image_completed",
    message: `Scene ${sceneIndex + 1} image ${targetImageIndex + 1} regenerated successfully`,
  });

  console.log(`[RegenerateImage] Scene ${sceneIndex + 1} img ${targetImageIndex + 1}: ${imageUrl.substring(0, 80)}`);

  // ── Auto-chain: after the primary image regen succeeds on a
  // cinematic project, queue a video regen so the scene's video clip
  // refreshes with the new image. Only runs for:
  //   - cinematic projects (other types don't have per-scene video)
  //   - targetImageIndex === 0 (the primary image)
  //   - scenes that previously had a video (avoid queuing for scenes
  //     whose video hasn't been produced yet — first-time generation
  //     flow handles those).
  //
  // Wrapped in try/catch: if the enqueue fails we still return success
  // for the image regen itself.
  try {
    const { data: proj } = await supabase
      .from("projects")
      .select("project_type")
      .eq("id", projectId)
      .maybeSingle();
    const isCinematic = proj?.project_type === "cinematic";
    const sceneHadVideo = !!scenes[sceneIndex]?.imageUrl; // guaranteed true now
    if (isCinematic && targetImageIndex === 0 && sceneHadVideo && userId) {
      const { error: chainErr } = await supabase
        .from("video_generation_jobs")
        .insert({
          user_id: userId,
          project_id: projectId,
          task_type: "cinematic_video",
          payload: {
            generationId,
            projectId,
            sceneIndex,
            regenerate: true,
            _chainedFromImage: true,
          },
          status: "pending",
        });
      if (chainErr) {
        console.warn(`[RegenerateImage] Auto-chain video regen failed (non-fatal): ${chainErr.message}`);
      } else {
        console.log(`[RegenerateImage] Auto-queued cinematic_video regen for scene ${sceneIndex + 1}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[RegenerateImage] Auto-chain skipped (non-fatal): ${msg}`);
  }

  return {
    success: true,
    sceneIndex,
    imageIndex: targetImageIndex,
    imageUrl,
    imageUrls: scenes[sceneIndex].imageUrls,
  };
}
