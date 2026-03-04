/**
 * Standard (non-cinematic) video generation pipeline: script → audio → images → finalize.
 * Handles doc2video, storytelling, and smartflow project types.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  type GenerationParams,
  type PipelineContext,
  normalizeScenes,
} from "./types";

const LOG = "[Pipeline:Standard]";

/** Execute the standard (non-cinematic) pipeline */
export async function runStandardPipeline(
  params: GenerationParams,
  ctx: PipelineContext,
  expectedSceneCount: number
): Promise<void> {
  console.log(LOG, "Starting standard pipeline", { projectType: params.projectType, format: params.format, length: params.length });

  // ============= PHASE 1: SCRIPT =============
  ctx.setState((prev) => ({ ...prev, step: "scripting" as const, progress: 5, statusMessage: "Generating script with AI..." }));

  const isSmartFlowNoVoice = params.projectType === "smartflow" && !params.voiceType;

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
    skipAudio: isSmartFlowNoVoice,
  }, 180000);

  if (!scriptResult.success) throw new Error(scriptResult.error || "Script generation failed");

  const { projectId, generationId, title, sceneCount, totalImages, costTracking } = scriptResult;
  console.log(LOG, "Script complete", { projectId, generationId, sceneCount, totalImages });

  ctx.setState((prev) => ({
    ...prev,
    step: "scripting" as const,
    progress: 10,
    projectId,
    generationId,
    title,
    sceneCount,
    totalImages,
    statusMessage: isSmartFlowNoVoice ? "Script complete. Starting images..." : "Script complete. Starting audio...",
    costTracking,
    phaseTimings: { script: scriptResult.phaseTime },
  }));

  // ============= PHASE 2: AUDIO (chunked) =============
  if (!isSmartFlowNoVoice) {
    console.log(LOG, "Starting audio phase");
    ctx.setState((prev) => ({ ...prev, step: "visuals" as const, progress: 15, statusMessage: "Generating voiceover audio..." }));

    let audioStartIndex = 0;
    let audioResult: any;

    do {
      audioResult = await ctx.callPhase({ phase: "audio", generationId, projectId, audioStartIndex }, 300000);
      if (!audioResult.success) throw new Error(audioResult.error || "Audio generation failed");

      console.log(LOG, "Audio chunk complete", { generated: audioResult.audioGenerated, hasMore: audioResult.hasMore });

      ctx.setState((prev) => ({
        ...prev,
        progress: typeof audioResult.progress === "number" ? audioResult.progress : prev.progress,
        statusMessage: audioResult.hasMore
          ? `Generating voiceover... (${audioResult.audioGenerated || 0}/${prev.sceneCount})`
          : `Audio complete (${audioResult.audioSeconds?.toFixed(1) || 0}s). Starting images...`,
        costTracking: audioResult.costTracking,
        phaseTimings: { ...prev.phaseTimings, audio: audioResult.phaseTime },
      }));

      if (audioResult.hasMore && typeof audioResult.nextStartIndex === "number") {
        audioStartIndex = audioResult.nextStartIndex;
      }
    } while (audioResult.hasMore);

    console.log(LOG, "Audio phase complete");
  }

  // ============= PHASE 3: IMAGES (chunked, fault-tolerant) =============
  console.log(LOG, "Starting images phase");
  ctx.setState((prev) => ({ ...prev, progress: 45, statusMessage: "Generating images..." }));

  let imageStartIndex = 0;
  let imagesResult: any;

  do {
    try {
      imagesResult = await ctx.callPhase({ phase: "images", generationId, projectId, imageStartIndex }, 480000);

      if (!imagesResult.success) {
        console.warn(LOG, `Image chunk at index ${imageStartIndex} failed: ${imagesResult.error}`);
        imageStartIndex += 4;
        imagesResult = { hasMore: imageStartIndex < (imagesResult?.totalImages || expectedSceneCount * 3) };
        continue;
      }
    } catch (err) {
      console.warn(LOG, `Image chunk at index ${imageStartIndex} error:`, err);
      imageStartIndex += 4;
      imagesResult = { hasMore: imageStartIndex < expectedSceneCount * 3 };
      continue;
    }

    ctx.setState((prev) => ({
      ...prev,
      progress: imagesResult.progress || prev.progress,
      completedImages: imagesResult.imagesGenerated || prev.completedImages,
      totalImages: imagesResult.totalImages || prev.totalImages,
      statusMessage: `Images ${imagesResult.imagesGenerated || 0}/${imagesResult.totalImages || prev.totalImages}...`,
      costTracking: imagesResult.costTracking || prev.costTracking,
      phaseTimings: { ...prev.phaseTimings, images: (prev.phaseTimings?.images || 0) + (imagesResult.phaseTime || 0) },
    }));

    if (imagesResult.hasMore && imagesResult.nextStartIndex !== undefined) {
      imageStartIndex = imagesResult.nextStartIndex;
    }
  } while (imagesResult.hasMore);

  // Retry missing images (up to 2 rounds)
  for (let retryRound = 0; retryRound < 2; retryRound++) {
    const { data: imgCheckGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
    const imgCheckScenes = normalizeScenes(imgCheckGen?.scenes) ?? [];
    const missingImageScenes = imgCheckScenes.filter((s) => !s.imageUrl).length;
    if (missingImageScenes === 0) break;

    console.log(LOG, `Image retry round ${retryRound + 1}: ${missingImageScenes} scenes missing`);
    ctx.setState((prev) => ({ ...prev, statusMessage: `Retrying ${missingImageScenes} missing images (round ${retryRound + 1})...` }));

    let retryIndex = 0;
    let retryResult: any;
    do {
      try {
        retryResult = await ctx.callPhase({ phase: "images", generationId, projectId, imageStartIndex: retryIndex }, 480000);
        if (retryResult?.hasMore && retryResult.nextStartIndex !== undefined) retryIndex = retryResult.nextStartIndex;
        else retryResult = { hasMore: false };
      } catch {
        retryResult = { hasMore: false };
      }
    } while (retryResult.hasMore);
  }

  // Re-fetch final image state
  const { data: postRetryGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
  const postRetryScenes = normalizeScenes(postRetryGen?.scenes) ?? [];
  const finalImagesGenerated = postRetryScenes.filter((s) => !!s.imageUrl).length;
  const finalTotalImages = imagesResult?.totalImages || postRetryScenes.length * 3;

  console.log(LOG, "Images phase complete", { generated: finalImagesGenerated, total: finalTotalImages });

  ctx.setState((prev) => ({
    ...prev,
    progress: 90,
    completedImages: finalImagesGenerated,
    totalImages: finalTotalImages,
    statusMessage: `Images complete (${finalImagesGenerated}/${finalTotalImages}). Finalizing...`,
    costTracking: imagesResult?.costTracking || prev.costTracking,
  }));

  // ============= PHASE 4: FINALIZE =============
  console.log(LOG, "Starting finalize phase");
  const finalResult = await ctx.callPhase({ phase: "finalize", generationId, projectId });
  if (!finalResult.success) throw new Error(finalResult.error || "Finalization failed");

  const finalScenes = normalizeScenes(finalResult.scenes);
  console.log(LOG, "Standard pipeline complete", { sceneCount: finalScenes?.length, title: finalResult.title });

  ctx.setState({
    step: "complete",
    progress: 100,
    sceneCount: finalScenes?.length || sceneCount,
    currentScene: finalScenes?.length || sceneCount,
    totalImages: imagesResult.totalImages,
    completedImages: imagesResult.imagesGenerated,
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
  });

  ctx.toast({
    title: "Video Generated!",
    description: `"${finalResult.title}" is ready with ${finalScenes?.length || 0} scenes.`,
  });
}
