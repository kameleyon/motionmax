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
import { updateSceneField, updateSceneFieldJson } from "../lib/sceneUpdate.js";
import {
  initSceneProgress,
  updateSceneProgress,
  flushSceneProgress,
  clearSceneProgress,
} from "../lib/sceneProgress.js";

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

  const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();

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
    .select("*, projects(format, style, brand_mark, character_consistency_enabled, project_type, character_description)")
    .eq("id", generationId)
    .maybeSingle();

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

  // Build the full task list
  const allTasks = buildImageTasks(scenes, buildOpts);
  const totalImages = allTasks.length;
  const tasksToProcess = allTasks.slice(imageStartIndex);

  console.log(`[Images] Processing all remaining tasks: ${tasksToProcess.length} of ${totalImages}`);

  // Initialize per-scene progress tracking
  initSceneProgress(jobId, scenes.length, "image_generation");
  // Mark scenes that already have images as complete
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i] as any;
    if (s.imageUrl) {
      await updateSceneProgress(jobId, i, "complete", {
        message: `Scene ${i + 1} images already generated`,
        flush: false,
      });
    }
  }
  await flushSceneProgress(jobId);

  // Track how many images are already done (from existing imageUrls / imageUrl)
  let completedSoFar = scenes.reduce((sum, s: any) => {
    const primary = s.imageUrl ? 1 : 0;
    const subs = Array.isArray(s.imageUrls) ? s.imageUrls.filter(Boolean).length : 0;
    return sum + primary + subs;
  }, 0);

  let newlyGenerated = 0;

  const pendingTasks = tasksToProcess.filter(({ sceneIndex, subIndex }) => {
    const scene = scenes[sceneIndex] as any;
    if (subIndex === 0 && scene.imageUrl) return false;
    if (subIndex > 0 && (scene.imageUrls || [])[subIndex]) return false;
    return true;
  });

  console.log(`[Images] Generating ${pendingTasks.length} images in parallel batches`);

  // Track timing for ETA calculation
  const imageStartTimes: number[] = [];
  const getEstimatedTimeRemaining = (completed: number, total: number): number => {
    if (imageStartTimes.length < 2 || completed === 0) return 0;
    const avgTimePerImage = (Date.now() - phaseStart) / completed;
    const remaining = total - completed;
    return Math.round((avgTimePerImage * remaining) / 1000); // Convert to seconds
  };

  // Process in batches of 9 to avoid overwhelming the API, but do all batches in this job
  const BATCH_SIZE = 9;
  for (let i = 0; i < pendingTasks.length; i += BATCH_SIZE) {
    const batch = pendingTasks.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async ({ sceneIndex, subIndex, prompt }) => {
        console.log(`[Images] → scene ${sceneIndex}, sub ${subIndex} (${prompt.length} chars)`);
        const imageStart = Date.now();
        const url = await generateImage(prompt, hyperealApiKey, replicateApiKey, format, projectId);
        imageStartTimes.push(imageStart);
        return { sceneIndex, subIndex, url };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { sceneIndex, subIndex, url } = result.value;

        // Update local tracking array
        const subs: (string | null)[] = Array.isArray((scenes[sceneIndex] as any).imageUrls)
          ? [...(scenes[sceneIndex] as any).imageUrls]
          : [null, null, null];

        if (subIndex === 0) {
          (scenes[sceneIndex] as any).imageUrl = url;
          subs[0] = url;
        } else {
          subs[subIndex] = url;
        }
        (scenes[sceneIndex] as any).imageUrls = subs;
        newlyGenerated++;
        completedSoFar++;

        // ── Atomic DB writes: update only the changed fields ──
        // Write imageUrl (primary/legacy) atomically
        if (subIndex === 0) {
          await updateSceneField(generationId, sceneIndex, "imageUrl", url);
        }
        // Write imageUrls array atomically (always, since every sub updates it)
        await updateSceneFieldJson(generationId, sceneIndex, "imageUrls", subs);

        // Update progress on the generations row (just the progress number)
        const progressAfter = Math.min(89, 45 + Math.round((completedSoFar / totalImages) * 44));
        const etaSeconds = getEstimatedTimeRemaining(completedSoFar, totalImages);
        const currentSceneNum = sceneIndex + 1;

        await supabase
          .from("generations")
          .update({ progress: progressAfter })
          .eq("id", generationId);

        // Update per-scene progress: check if all images for this scene are done
        const sceneImgUrls = (scenes[sceneIndex] as any).imageUrls || [];
        const sceneImgCount = sceneImgUrls.filter(Boolean).length;
        const sceneSubVisuals = (scenes[sceneIndex] as any).subVisuals || [];
        const expectedCount = 1 + Math.min(2, sceneSubVisuals.length); // primary + up to 2 subs
        const sceneComplete = sceneImgCount >= expectedCount;

        await updateSceneProgress(jobId, sceneIndex, sceneComplete ? "complete" : "generating", {
          message: sceneComplete
            ? `Scene ${currentSceneNum} — all images generated`
            : `Scene ${currentSceneNum} — ${sceneImgCount}/${expectedCount} images`,
          flush: false,
        });

        console.log(`[Images] ✅ Image ${completedSoFar}/${totalImages} — Scene ${currentSceneNum} — Progress: ${progressAfter}% — ETA: ${etaSeconds}s`);
      } else {
        console.error(`[Images] Parallel task failed:`, result.reason);
      }
    }

    // Flush scene progress after each batch
    await flushSceneProgress(jobId);
  }

  const phaseTime = Date.now() - phaseStart;
  const progress = Math.min(89, 45 + Math.round((completedSoFar / totalImages) * 44));

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "images_phase_completed",
    message: `Images phase done: ${newlyGenerated} new, ${completedSoFar}/${totalImages} total`,
    details: { imageStartIndex, newlyGenerated, completedSoFar, totalImages, phaseTime },
  });

  clearSceneProgress(jobId);

  return {
    success: true,
    imagesGenerated: newlyGenerated,
    totalImages,
    hasMore: false,
    progress,
    phaseTime,
  };
}
