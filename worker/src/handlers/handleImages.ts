/**
 * Images phase handler for the Node.js worker.
 *
 * Reads the generation from Supabase, processes one chunk of image tasks
 * (MAX_IMAGES_PER_CALL default), writes results back to the DB scene rows,
 * and returns a result object the frontend can read from the job payload.
 *
 * Mirrors handleImagesPhase() from supabase/functions/generate-video/index.ts
 * but runs without any timeout ceiling (Render has no execution time cap).
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { buildImageTasks, type Scene, type BuildPromptOptions } from "../services/imagePromptBuilder.js";
import { generateImage } from "../services/imageGenerator.js";

// ── Constants ──────────────────────────────────────────────────────

// Process 9 images per job invocation (3 full scenes × 3 images each).
// Images run in parallel so 9 images ≈ ~10-15s total instead of 72s sequential.
const MAX_IMAGES_PER_CALL = 9;

// ── Types ──────────────────────────────────────────────────────────

interface ImagesPayload {
  generationId: string;
  projectId: string;
  imageStartIndex?: number;
  phase?: string;
  [key: string]: unknown;
}

interface ImagesResult {
  success: boolean;
  imagesGenerated: number;
  totalImages: number;
  hasMore: boolean;
  nextStartIndex?: number;
  progress: number;
  phaseTime: number;
}

// ── Handler ────────────────────────────────────────────────────────

export async function handleImagesPhase(
  jobId: string,
  payload: ImagesPayload,
  userId?: string,
): Promise<ImagesResult> {
  const phaseStart = Date.now();
  const { generationId, projectId } = payload;
  const imageStartIndex = typeof payload.imageStartIndex === "number" ? payload.imageStartIndex : 0;

  const hyperealApiKey = process.env.HYPEREAL_API_KEY || "";
  const replicateApiKey = process.env.REPLICATE_API_KEY || "";

  if (!hyperealApiKey && !replicateApiKey) {
    throw new Error("Neither HYPEREAL_API_KEY nor REPLICATE_API_KEY is configured");
  }

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "images_phase_started",
    message: `Images phase started at index ${imageStartIndex}`,
  });

  // Fetch generation + project data
  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("*, projects!inner(format, style, brand_mark, character_consistency_enabled, project_type, character_description)")
    .eq("id", generationId)
    .single();

  if (genError || !generation) {
    throw new Error(`Generation not found: ${genError?.message}`);
  }

  const scenes: Scene[] = (generation.scenes as Scene[]) || [];
  const meta = (scenes[0] as any)?._meta || {};
  const characterBible: Record<string, string> = meta.characterBible || {};

  const format: string = generation.projects?.format || "landscape";
  const style: string = generation.projects?.style || "realistic";
  const characterDescription: string = generation.projects?.character_description || "";
  const isSmartFlow: boolean = generation.projects?.project_type === "smartflow";

  const buildOpts: BuildPromptOptions = {
    format,
    style,
    characterBible,
    characterDescription,
    isSmartFlow,
  };

  // Build the full task list then slice the current chunk
  const allTasks = buildImageTasks(scenes, buildOpts);
  const totalImages = allTasks.length;
  const chunkEnd = Math.min(imageStartIndex + MAX_IMAGES_PER_CALL, totalImages);
  const chunk = allTasks.slice(imageStartIndex, chunkEnd);

  console.log(`[Images] Processing chunk: tasks ${imageStartIndex}-${chunkEnd - 1} of ${totalImages}`);

  // Track how many images are already done (from existing imageUrls / imageUrl)
  let completedSoFar = scenes.reduce((sum, s: any) => {
    const primary = s.imageUrl ? 1 : 0;
    const subs = Array.isArray(s.imageUrls) ? s.imageUrls.filter(Boolean).length : 0;
    return sum + primary + subs;
  }, 0);

  // Process all tasks in the chunk IN PARALLEL — dramatically speeds up image generation.
  // Hypereal handles concurrent requests fine; each takes ~5-10s.
  let newlyGenerated = 0;

  const pendingTasks = chunk.filter(({ sceneIndex, subIndex }) => {
    const scene = scenes[sceneIndex] as any;
    if (subIndex === 0 && scene.imageUrl) return false;
    if (subIndex > 0 && (scene.imageUrls || [])[subIndex]) return false;
    return true;
  });

  console.log(`[Images] Generating ${pendingTasks.length} images in parallel (chunk ${imageStartIndex}-${chunkEnd - 1})`);

  const results = await Promise.allSettled(
    pendingTasks.map(async ({ sceneIndex, subIndex, prompt }) => {
      console.log(`[Images] → scene ${sceneIndex}, sub ${subIndex} (${prompt.length} chars)`);
      const url = await generateImage(prompt, hyperealApiKey, replicateApiKey, format, projectId);
      return { sceneIndex, subIndex, url };
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { sceneIndex, subIndex, url } = result.value;
      const subs: (string | null)[] = Array.isArray((scenes[sceneIndex] as any).imageUrls)
        ? [...(scenes[sceneIndex] as any).imageUrls]
        : [null, null, null];

      if (subIndex === 0) {
        // Write primary to both imageUrl (legacy) AND imageUrls[0] (carousel)
        (scenes[sceneIndex] as any).imageUrl = url;
        subs[0] = url;
      } else {
        subs[subIndex] = url;
      }
      (scenes[sceneIndex] as any).imageUrls = subs;
      newlyGenerated++;
      completedSoFar++;
    } else {
      console.error(`[Images] Parallel task failed:`, result.reason);
    }
  }

  // Single DB write after the entire parallel batch completes
  const progressAfter = Math.min(89, 45 + Math.round((completedSoFar / totalImages) * 44));
  await supabase
    .from("generations")
    .update({
      progress: progressAfter,
      scenes: scenes.map((s: any, idx: number) => ({
        ...s,
        _meta: {
          ...((scenes[idx] as any)._meta || {}),
          completedImages: completedSoFar,
          totalImages,
          statusMessage: `Images ${completedSoFar}/${totalImages}...`,
        },
      })),
    })
    .eq("id", generationId);

  const hasMore = chunkEnd < totalImages;
  const phaseTime = Date.now() - phaseStart;
  const progress = Math.min(89, 45 + Math.round((completedSoFar / totalImages) * 44));

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "images_chunk_completed",
    message: `Images chunk done: ${newlyGenerated} new, ${completedSoFar}/${totalImages} total, hasMore=${hasMore}`,
    details: { imageStartIndex, chunkEnd, newlyGenerated, completedSoFar, totalImages, hasMore, phaseTime },
  });

  return {
    success: true,
    imagesGenerated: newlyGenerated,
    totalImages,
    hasMore,
    nextStartIndex: hasMore ? chunkEnd : undefined,
    progress,
    phaseTime,
  };
}
