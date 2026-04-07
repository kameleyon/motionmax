/**
 * Unified generation pipeline for ALL project types.
 *
 * Uses server-side job dependencies:
 * 1. Script job runs first (creates project + generation)
 * 2. All audio + image jobs pre-submitted with depends_on: [scriptJobId]
 * 3. Cinematic video jobs depend on their image jobs
 * 4. Finalize depends on all audio + video (or image) jobs
 *
 * Pipeline survives browser close — worker handles all sequencing.
 */
import { createScopedLogger } from "@/lib/logger";
import {
  type GenerationParams,
  type PipelineContext,
  normalizeScenes,
} from "./types";
import { submitJob, waitForJob } from "./callPhase";

const log = createScopedLogger("Pipeline:Unified");

export async function runUnifiedPipeline(
  params: GenerationParams,
  ctx: PipelineContext,
  expectedSceneCount: number
): Promise<void> {
  const isCinematic = params.projectType === "cinematic";

  log.debug("Starting unified pipeline", { projectType: params.projectType, format: params.format, length: params.length });

  // ============= PHASE 1: SCRIPT (must complete first to get IDs) =============
  ctx.setState((prev) => ({ ...prev, step: "scripting" as const, progress: 5, statusMessage: "Generating... this may take a moment" }));

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
  }, 480000);

  if (!scriptResult.success) throw new Error(scriptResult.error || "Script generation failed");

  const { projectId, generationId, title, sceneCount, totalImages, costTracking } = scriptResult;
  log.debug("Script complete", { projectId, generationId, sceneCount, totalImages });

  ctx.setState((prev) => ({
    ...prev,
    step: "visuals" as const,
    progress: 15,
    projectId,
    generationId,
    title,
    sceneCount,
    totalImages,
    statusMessage: "Creating your content...",
    costTracking,
    phaseTimings: { script: scriptResult.phaseTime },
  }));

  // ============= PHASE 2: PRE-SUBMIT ALL REMAINING JOBS WITH DEPENDENCIES =============
  // No more client-side orchestration — worker handles sequencing via depends_on

  const audioJobIds: string[] = [];
  const imageJobIds: string[] = [];
  const videoJobIds: string[] = [];

  // Submit all audio jobs (no dependencies — script already complete)
  for (let i = 0; i < sceneCount; i++) {
    const jobId = await submitJob(
      { phase: "audio", projectId, generationId, sceneIndex: i, language: params.language },
      "cinematic_audio",
    );
    audioJobIds.push(jobId);
  }
  log.debug(`Submitted ${audioJobIds.length} audio jobs`);

  // Submit all image jobs (no dependencies — script already complete)
  for (let i = 0; i < sceneCount; i++) {
    const jobId = await submitJob(
      { phase: "images", projectId, generationId, sceneIndex: i },
      "cinematic_image",
    );
    imageJobIds.push(jobId);
  }
  log.debug(`Submitted ${imageJobIds.length} image jobs`);

  // Cinematic: submit video jobs with image dependencies
  if (isCinematic) {
    for (let i = 0; i < sceneCount; i++) {
      // Video[i] depends on image[i] + image[i+1] (for transition)
      const deps = [imageJobIds[i]];
      if (i < sceneCount - 1) deps.push(imageJobIds[i + 1]);

      const jobId = await submitJob(
        { phase: "video", projectId, generationId, sceneIndex: i },
        "cinematic_video",
        deps,
      );
      videoJobIds.push(jobId);
    }
    log.debug(`Submitted ${videoJobIds.length} video jobs with image dependencies`);
  }

  // Submit finalize job — depends on ALL audio + ALL video (or image) jobs
  const finalizeDeps = [...audioJobIds, ...(isCinematic ? videoJobIds : imageJobIds)];
  const finalizeJobId = await submitJob(
    { phase: "finalize", generationId, projectId },
    "finalize_generation",
    finalizeDeps,
  );
  log.debug(`Submitted finalize job (depends on ${finalizeDeps.length} jobs)`);

  // ============= PHASE 3: WAIT FOR COMPLETION =============
  // All jobs are in the queue with proper dependencies.
  // Just wait for the finalize job — it won't run until everything else completes.

  ctx.setState((prev) => ({ ...prev, statusMessage: "Creating your content..." }));

  // Monitor progress by waiting for finalize (Realtime + fallback polling)
  const finalResult = await waitForJob(finalizeJobId, 30 * 60 * 1000, "finalize_generation");

  if (!finalResult.success) throw new Error(finalResult.error || "Generation failed");

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
    statusMessage: "Done!",
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
