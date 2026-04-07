/**
 * Unified generation pipeline for ALL project types.
 * script → audio + images (per-scene, parallel) → video (cinematic only) → finalize
 */
import { createScopedLogger } from "@/lib/logger";
import { db } from "@/lib/databaseService";
import {
  type GenerationParams,
  type PipelineContext,
  normalizeScenes,
  CINEMATIC_ENDPOINT,
  DEFAULT_ENDPOINT,
} from "./types";

const log = createScopedLogger("Pipeline:Unified");

const AUDIO_CONCURRENCY = 5;

/** Infer the endpoint from project type */
function getEndpoint(projectType: string): string {
  return projectType === "cinematic" ? CINEMATIC_ENDPOINT : DEFAULT_ENDPOINT;
}

export async function runUnifiedPipeline(
  params: GenerationParams,
  ctx: PipelineContext,
  expectedSceneCount: number
): Promise<void> {
  const isCinematic = params.projectType === "cinematic";
  const endpoint = getEndpoint(params.projectType || "doc2video");

  log.debug("Starting unified pipeline", { projectType: params.projectType, format: params.format, length: params.length });

  // ============= PHASE 1: SCRIPT =============
  ctx.setState((prev) => ({ ...prev, step: "scripting" as const, progress: 5, statusMessage: "Generating script with AI..." }));

  const scriptResult = await ctx.callPhase({
    phase: "script",
    content: params.content,
    format: params.format,
    length: params.length,
    style: params.style,
    customStyle: params.customStyle,
    customStyleImage: params.customStyleImage,
    brandMark: params.brandMark,
    presenterFocus: params.presenterFocus,
    characterDescription: params.characterDescription,
    disableExpressions: params.disableExpressions,
    characterConsistencyEnabled: params.characterConsistencyEnabled,
    voiceType: params.voiceType,
    voiceId: params.voiceId,
    voiceName: params.voiceName,
    projectType: params.projectType,
    inspirationStyle: params.inspirationStyle,
    storyTone: params.storyTone,
    storyGenre: params.storyGenre,
    voiceInclination: params.voiceInclination,
    brandName: params.brandName,
    language: params.language,
  }, 480000, endpoint);

  if (!scriptResult.success) throw new Error(scriptResult.error || "Script generation failed");

  const { projectId, generationId, title, sceneCount, totalImages, costTracking } = scriptResult;
  log.debug("Script complete", { projectId, generationId, sceneCount, totalImages });

  ctx.setState((prev) => ({
    ...prev,
    step: "scripting" as const,
    progress: 10,
    projectId,
    generationId,
    title,
    sceneCount,
    totalImages,
    statusMessage: "Script complete. Starting audio & images...",
    costTracking,
    phaseTimings: { script: scriptResult.phaseTime },
  }));

  // ============= PHASE 2: AUDIO + IMAGES (per-scene, parallel) =============
  ctx.setState((prev) => ({ ...prev, step: "visuals" as const, progress: 15, statusMessage: "Generating audio & images..." }));

  // --- Audio: per-scene jobs, batched by AUDIO_CONCURRENCY ---
  const audioPromise = (async () => {
    for (let batchStart = 0; batchStart < sceneCount; batchStart += AUDIO_CONCURRENCY) {
      const batchEnd = Math.min(batchStart + AUDIO_CONCURRENCY, sceneCount);
      const batch: Promise<unknown>[] = [];
      for (let i = batchStart; i < batchEnd; i++) {
        batch.push(
          ctx.callPhase({ phase: "audio", projectId, generationId, sceneIndex: i, language: params.language }, 300000, endpoint)
            .catch((err) => { log.warn(`Audio scene ${i} failed:`, err); return { success: false }; })
        );
      }
      const results = await Promise.all(batch);
      const failures = results.filter((r: any) => r && r.success === false);
      if (failures.length > 0) {
        log.warn(`${failures.length}/${batch.length} audio scenes failed in batch`);
      }
      if (failures.length === batch.length) {
        throw new Error(`All ${batch.length} audio scenes failed`);
      }

      ctx.setState((prev) => ({
        ...prev,
        progress: 10 + Math.floor(((batchEnd) / sceneCount) * 25),
        statusMessage: `Audio ${batchEnd}/${sceneCount}...`,
      }));
    }
  })();

  // --- Images: all per-scene jobs in parallel ---
  const imagePromises: Promise<unknown>[] = [];
  const videoPromises: Promise<unknown>[] = []; // cinematic only

  // For cinematic streaming: track image completion per scene
  const imageReady: Record<number, Promise<void>> = {};
  const imageResolvers: Record<number, () => void> = {};

  if (isCinematic) {
    for (let i = 0; i < sceneCount; i++) {
      imageReady[i] = new Promise<void>((resolve) => { imageResolvers[i] = resolve; });
    }
  }

  for (let i = 0; i < sceneCount; i++) {
    const imagePromise = ctx.callPhase(
      { phase: "images", projectId, generationId, sceneIndex: i },
      600000, endpoint
    ).then((result: unknown) => {
      if (isCinematic && imageResolvers[i]) imageResolvers[i]();
      ctx.setState((prev) => ({
        ...prev,
        completedImages: (prev.completedImages || 0) + 1,
        progress: Math.min(89, 35 + Math.floor(((prev.completedImages || 0) + 1) / sceneCount * 50)),
        statusMessage: `Images ${(prev.completedImages || 0) + 1}/${sceneCount}...`,
      }));
      return result;
    }).catch((err: unknown) => {
      log.warn(`Image scene ${i} failed:`, err);
      if (isCinematic && imageResolvers[i]) imageResolvers[i](); // unblock video even on failure
      return { success: false };
    });

    imagePromises.push(imagePromise);

    // Cinematic: fire video jobs as images complete (streaming)
    if (isCinematic) {
      const sceneIdx = i; // capture for closure
      const videoPromise = (async () => {
        // Wait for current scene image + next scene image (for transition)
        await imageReady[sceneIdx];
        if (sceneIdx < sceneCount - 1) await imageReady[sceneIdx + 1];

        return ctx.callPhase(
          { phase: "video", projectId, generationId, sceneIndex: sceneIdx },
          20 * 60 * 1000, endpoint
        ).then((result: unknown) => {
          ctx.setState((prev) => ({
            ...prev,
            statusMessage: `Video ${sceneIdx + 1}/${sceneCount}...`,
          }));
          return result;
        }).catch((err: unknown) => {
          log.warn(`Video scene ${sceneIdx} failed:`, err);
          return { success: false };
        });
      })();
      videoPromises.push(videoPromise);
    }
  }

  // Wait for audio + images + videos (cinematic) to all complete
  await Promise.all([audioPromise, ...imagePromises, ...videoPromises]);

  // --- Retry missing images (1 round) ---
  const { data: checkRows } = await db.query("generations", (q) => q.eq("id", generationId).limit(1));
  const checkGen = checkRows?.[0] as Record<string, unknown> | undefined;
  const checkScenes = normalizeScenes(checkGen?.scenes) ?? [];
  const missingImages = checkScenes.filter((s) => !s.imageUrl).length;

  if (missingImages > 0) {
    log.debug(`Retrying ${missingImages} missing images`);
    ctx.setState((prev) => ({ ...prev, statusMessage: `Retrying ${missingImages} missing images...` }));
    const retryPromises = checkScenes
      .map((s, i) => (!s.imageUrl ? i : -1))
      .filter((i) => i >= 0)
      .map((i) =>
        ctx.callPhase({ phase: "images", projectId, generationId, sceneIndex: i }, 480000, endpoint)
          .catch((err: unknown) => log.warn(`Image retry scene ${i} failed:`, err))
      );
    await Promise.allSettled(retryPromises);
  }

  // Cinematic: retry missing videos (1 round)
  if (isCinematic) {
    const { data: vidCheckRows } = await db.query("generations", (q) => q.eq("id", generationId).limit(1));
    const vidCheckGen = vidCheckRows?.[0] as Record<string, unknown> | undefined;
    const vidCheckScenes = normalizeScenes(vidCheckGen?.scenes) ?? [];
    const missingVideos = vidCheckScenes.filter((s) => !s.videoUrl).length;

    if (missingVideos > 0) {
      log.debug(`Retrying ${missingVideos} missing videos`);
      ctx.setState((prev) => ({ ...prev, statusMessage: `Retrying ${missingVideos} missing clips...` }));
      const retryPromises = vidCheckScenes
        .map((s, i) => (!s.videoUrl ? i : -1))
        .filter((i) => i >= 0)
        .map((i) =>
          ctx.callPhase({ phase: "video", projectId, generationId, sceneIndex: i }, 20 * 60 * 1000, endpoint)
            .catch((err: unknown) => log.warn(`Video retry scene ${i} failed:`, err))
        );
      await Promise.allSettled(retryPromises);
    }
  }

  ctx.setState((prev) => ({
    ...prev,
    progress: 90,
    statusMessage: "Finalizing...",
  }));

  // ============= PHASE 3: FINALIZE =============
  log.debug("Starting finalize phase");
  const finalResult = await ctx.callPhase({ phase: "finalize", generationId, projectId }, 120000, endpoint);
  if (!finalResult.success) throw new Error(finalResult.error || "Finalization failed");

  const finalScenes = normalizeScenes(finalResult.scenes);
  log.debug("Unified pipeline complete", { sceneCount: finalScenes?.length, title: finalResult.title });

  ctx.setState({
    step: "complete",
    progress: 100,
    sceneCount: finalScenes?.length || sceneCount,
    currentScene: finalScenes?.length || sceneCount,
    totalImages: totalImages,
    completedImages: totalImages,
    isGenerating: false,
    projectId,
    generationId,
    title: finalResult.title,
    scenes: finalScenes,
    format: params.format as "landscape" | "portrait" | "square",
    statusMessage: "Generation complete!",
    costTracking: finalResult.costTracking,
    phaseTimings: finalResult.phaseTimings,
    totalTimeMs: finalResult.totalTimeMs,
    projectType: params.projectType,
  });

  ctx.toast({
    title: "Video Generated!",
    description: `"${finalResult.title}" is ready with ${finalScenes?.length || 0} scenes.`,
  });
}
