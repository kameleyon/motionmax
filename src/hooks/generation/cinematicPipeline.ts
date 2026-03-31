/**
 * Cinematic video generation pipeline: script → audio → images → video → finalize.
 * Also handles resuming interrupted cinematic generations.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  type GenerationParams,
  type PipelineContext,
  type ProjectRow,
  type Scene,
  CINEMATIC_ENDPOINT,
  normalizeScenes,
  sleep,
} from "./types";

const LOG = "[Pipeline:Cinematic]";

// Global rate-limit cooldown shared across image and video phases
let lastRateLimitTime = 0;
const GLOBAL_COOLDOWN_MS = 15000;

// ---- Main Pipeline ----

/** Execute the full cinematic pipeline from scratch */
export async function runCinematicPipeline(
  params: GenerationParams,
  ctx: PipelineContext
): Promise<void> {
  console.log(LOG, "Starting cinematic pipeline", { format: params.format, length: params.length, style: params.style });

  // Phase 1: Script
  ctx.setState((prev) => ({ ...prev, step: "scripting" as const, progress: 5, statusMessage: "Generating cinematic script..." }));

  const scriptResult = await ctx.callPhase(
    {
      phase: "script",
      projectType: "cinematic",
      content: params.content,
      format: params.format,
      length: params.length,
      style: params.style,
      customStyle: params.customStyle,
      brandMark: params.brandMark,
      presenterFocus: params.presenterFocus,
      characterDescription: params.characterDescription,
      disableExpressions: params.disableExpressions,
      characterConsistencyEnabled: params.characterConsistencyEnabled,
      voiceType: params.voiceType,
      voiceId: params.voiceId,
      voiceName: params.voiceName,
      language: params.language,
    },
    180000,
    CINEMATIC_ENDPOINT
  );

  if (!scriptResult.success) throw new Error(scriptResult.error || "Script generation failed");

  const projectId = scriptResult.projectId;
  const generationId = scriptResult.generationId;
  const title = scriptResult.title;
  const sceneCount = scriptResult.sceneCount;

  console.log(LOG, "Script phase complete", { projectId, generationId, sceneCount, title });

  ctx.setState((prev) => ({
    ...prev,
    step: "visuals" as const,
    progress: 10,
    projectId,
    generationId,
    title,
    sceneCount,
    statusMessage: "Script complete. Generating audio...",
  }));

  // Phase 2: Audio (all scenes in parallel)
  await runCinematicAudio(projectId, generationId, sceneCount, ctx, params.language);
  // Phase 3+4: Generate scene 1 image → chain videos sequentially (each uses previous video's last frame)
  await runCinematicVisuals(projectId, generationId, sceneCount, ctx);

  // Phase 5: Finalize
  await finalizeCinematic(projectId, generationId, sceneCount, params.format, ctx);

  ctx.toast({ title: "Cinematic Video Generated!", description: `"${title}" is ready.` });
}

// ---- Sub-Phases ----

async function runCinematicAudio(projectId: string, generationId: string, sceneCount: number, ctx: PipelineContext, language?: string) {
  console.log(LOG, "Starting audio phase", { sceneCount });

  const AUDIO_CONCURRENCY = 3;

  const processAudioScene = async (i: number) => {
    ctx.setState((prev) => ({
      ...prev,
      statusMessage: `Generating audio (${i + 1}/${sceneCount})...`,
      progress: 10 + Math.floor(((i + 0.25) / sceneCount) * 25),
    }));

    const audioRes = await ctx.callPhase(
      { phase: "audio", projectId, generationId, sceneIndex: i, language },
      300000,
      CINEMATIC_ENDPOINT
    );
    if (!audioRes.success) throw new Error(audioRes.error || "Audio generation failed");
    console.log(LOG, `Audio scene ${i + 1}/${sceneCount} complete`);

    ctx.setState((prev) => ({
      ...prev,
      progress: 10 + Math.floor(((i + 1) / sceneCount) * 25),
    }));
  };

  for (let batchStart = 0; batchStart < sceneCount; batchStart += AUDIO_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + AUDIO_CONCURRENCY, sceneCount);
    const batch: Promise<void>[] = [];
    for (let i = batchStart; i < batchEnd; i++) batch.push(processAudioScene(i));
    console.log(LOG, `Processing audio batch ${batchStart + 1}–${batchEnd}`);
    await Promise.allSettled(batch);
  }
  console.log(LOG, "Audio phase complete");
}

/** Parallel image generation → video dispatch only when BOTH frames are ready.
 *
 *  - 4 images sent to Hypereal in parallel (batches)
 *  - Video for scene N dispatched ONLY when image N AND image N+1 are ready
 *    (last scene doesn't need a next image)
 *  - This avoids worker slots sitting idle polling for the next image
 */
async function runCinematicVisuals(projectId: string, generationId: string, sceneCount: number, ctx: PipelineContext) {
  console.log(LOG, "Starting parallel image→video phase", { sceneCount });
  ctx.setState((prev) => ({ ...prev, progress: 35, statusMessage: "Audio complete. Generating visuals..." }));

  const IMAGE_CONCURRENCY = 4;
  let completedImages = 0;
  let completedVideos = 0;
  const imageReady = new Set<number>();
  const videoDispatched = new Set<number>();
  const videoPromises: Promise<void>[] = [];

  const updateProgress = () => {
    ctx.setState((prev) => ({
      ...prev,
      statusMessage: `Images ${completedImages}/${sceneCount} | Clips ${completedVideos}/${sceneCount}`,
      progress: 35 + Math.floor(((completedImages + completedVideos) / (sceneCount * 2)) * 60),
    }));
  };

  /** Dispatch a video job for scene idx (fire-and-forget). */
  const dispatchVideo = (idx: number) => {
    if (videoDispatched.has(idx)) return;
    videoDispatched.add(idx);
    const isLast = idx >= sceneCount - 1;
    console.log(LOG, `Scene ${idx + 1}: dispatching video (${isLast ? "last scene, no morph" : `morph → scene ${idx + 2}`})`);

    const task = (async () => {
      try {
        const { data: g } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
        if ((normalizeScenes(g?.scenes) ?? [])[idx]?.videoUrl) {
          console.log(LOG, `Scene ${idx + 1}: already has videoUrl, skipping`);
        } else {
          const r = await ctx.callPhase(
            { phase: "video", projectId, generationId, sceneIndex: idx },
            20 * 60 * 1000, CINEMATIC_ENDPOINT
          );
          if (!r.success) console.warn(LOG, `Scene ${idx + 1} video failed: ${r.error}`);
          else console.log(LOG, `Scene ${idx + 1} video complete`);
        }
      } catch (err) {
        console.warn(LOG, `Scene ${idx + 1} video error:`, err);
      }
      completedVideos++;
      updateProgress();
    })();
    videoPromises.push(task);
  };

  /** Try dispatching videos that are now eligible (both images ready). */
  const tryDispatchEligible = (justCompleted: number) => {
    // Scene justCompleted: needs image justCompleted + image justCompleted+1
    if (imageReady.has(justCompleted)) {
      const isLast = justCompleted >= sceneCount - 1;
      if (isLast || imageReady.has(justCompleted + 1)) dispatchVideo(justCompleted);
    }
    // Scene justCompleted-1: was waiting for this image as its "next frame"
    if (justCompleted > 0 && imageReady.has(justCompleted - 1)) {
      dispatchVideo(justCompleted - 1);
    }
  };

  /** Generate image for one scene. On success → check eligible videos. */
  const processImage = async (i: number) => {
    const now = Date.now();
    if (now - lastRateLimitTime < GLOBAL_COOLDOWN_MS) {
      const wait = GLOBAL_COOLDOWN_MS - (now - lastRateLimitTime);
      console.log(LOG, `Scene ${i + 1} image: cooldown ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    }

    try {
      const imgRes = await ctx.callPhase(
        { phase: "images", projectId, generationId, sceneIndex: i },
        480000, CINEMATIC_ENDPOINT
      );
      if (!imgRes.success) {
        if (imgRes.retryAfterMs && imgRes.retryAfterMs >= 20000) lastRateLimitTime = Date.now();
        console.warn(LOG, `Scene ${i + 1} image failed: ${imgRes.error}`);
      } else {
        imageReady.add(i);
      }
    } catch (err) {
      console.warn(LOG, `Scene ${i + 1} image error:`, err);
    }

    completedImages++;
    updateProgress();
    tryDispatchEligible(i);
  };

  // Process images in parallel batches of IMAGE_CONCURRENCY
  for (let batchStart = 0; batchStart < sceneCount; batchStart += IMAGE_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + IMAGE_CONCURRENCY, sceneCount);
    const batch: Promise<void>[] = [];
    for (let i = batchStart; i < batchEnd; i++) batch.push(processImage(i));
    console.log(LOG, `Image batch ${batchStart + 1}–${batchEnd} (${IMAGE_CONCURRENCY} parallel)`);
    await Promise.allSettled(batch);
  }

  // Failsafe: dispatch any un-dispatched videos (worker will auto-generate missing images)
  for (let i = 0; i < sceneCount; i++) {
    if (!videoDispatched.has(i)) {
      console.warn(LOG, `Scene ${i + 1}: image missing, dispatching video anyway`);
      dispatchVideo(i);
    }
  }

  // Wait for ALL in-flight video jobs
  console.log(LOG, `All images done. Waiting for ${videoPromises.length} in-flight video jobs...`);
  await Promise.allSettled(videoPromises);

  // Retry missing videos (1 round)
  const { data: latestGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
  const latestScenes = normalizeScenes(latestGen?.scenes) ?? [];
  const missingVids = latestScenes.map((s, i) => (!s.videoUrl ? i : -1)).filter((i) => i >= 0);
  if (missingVids.length > 0) {
    console.log(LOG, `Retrying ${missingVids.length} missing videos`);
    ctx.setState((prev) => ({ ...prev, statusMessage: `Retrying ${missingVids.length} missing clips...` }));
    for (const idx of missingVids) {
      try {
        await ctx.callPhase({ phase: "video", projectId, generationId, sceneIndex: idx }, 20 * 60 * 1000, CINEMATIC_ENDPOINT);
      } catch { /* continue */ }
    }
  }

  console.log(LOG, "Parallel image→video phase complete");
}

async function finalizeCinematic(projectId: string, generationId: string, sceneCount: number, format: string, ctx: PipelineContext) {
  console.log(LOG, "Starting finalize phase");
  ctx.setState((prev) => ({ ...prev, step: "rendering" as const, progress: 96, statusMessage: "Finalizing cinematic..." }));

  const finalRes = await ctx.callPhase(
    { phase: "finalize", projectId, generationId },
    120000,
    CINEMATIC_ENDPOINT
  );
  if (!finalRes.success) throw new Error(finalRes.error || "Finalization failed");

  const finalScenes = normalizeScenes(finalRes.scenes);
  console.log(LOG, "Cinematic pipeline complete", { sceneCount: finalScenes?.length, title: finalRes.title });

  ctx.setState({
    step: "complete",
    progress: 100,
    sceneCount: finalScenes?.length || sceneCount,
    currentScene: finalScenes?.length || sceneCount,
    totalImages: finalScenes?.length || sceneCount,
    completedImages: finalScenes?.length || sceneCount,
    isGenerating: false,
    projectId,
    generationId,
    title: finalRes.title,
    scenes: finalScenes,
    format: format as "landscape" | "portrait" | "square",
    finalVideoUrl: finalRes.finalVideoUrl,
    statusMessage: "Cinematic video generated!",
    projectType: "cinematic",
  });
}

// ---- Shared Retry Logic ----

async function retryMissingImages(generationId: string, sceneCount: number, ctx: PipelineContext, projectId: string) {
  // FIX 3: Reduced from 2 rounds to 1 to prevent double-billing on timeouts
  for (let round = 0; round < 1; round++) {
    const { data: gen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
    const scenes = normalizeScenes(gen?.scenes) ?? [];
    const missing = scenes.map((s, i) => (!s.imageUrl ? i : -1)).filter((i) => i >= 0);
    if (missing.length === 0) break;

    console.log(LOG, `Image retry round ${round + 1}: ${missing.length} scenes missing`);
    ctx.setState((prev) => ({ ...prev, statusMessage: `Retrying ${missing.length} missing images (round ${round + 1})...` }));

    for (const idx of missing) {
      // Respect global rate-limit cooldown
      const now = Date.now();
      if (now - lastRateLimitTime < GLOBAL_COOLDOWN_MS) {
        const cooldownWait = GLOBAL_COOLDOWN_MS - (now - lastRateLimitTime);
        console.log(LOG, `Image retry ${idx + 1}: global cooldown, waiting ${(cooldownWait / 1000).toFixed(1)}s`);
        await sleep(cooldownWait);
      }
      try {
        const imgRes = await ctx.callPhase(
          { phase: "images", projectId, generationId, sceneIndex: idx },
          480000,
          CINEMATIC_ENDPOINT
        );
        if (imgRes && imgRes.retryAfterMs && imgRes.retryAfterMs >= 20000) {
          lastRateLimitTime = Date.now();
        }
      } catch {
        // Continue with remaining retries
      }
    }
  }
}

// ---- Resume Logic ----

/** Resume an interrupted cinematic generation from the last completed phase */
export async function resumeCinematicPipeline(
  project: ProjectRow,
  generationId: string,
  existingScenes: Scene[],
  resumeFrom: "audio" | "images" | "video" | "finalize",
  ctx: PipelineContext
): Promise<void> {
  const projectId = project.id;
  const sceneCount = existingScenes.length;
  const phaseLabels = { audio: "Resuming audio...", images: "Resuming images...", video: "Resuming video clips...", finalize: "Finalizing..." };

  console.log(LOG, `Resuming cinematic from "${resumeFrom}"`, { projectId, generationId, sceneCount });

  ctx.setState((prev) => ({
    ...prev,
    step: "visuals" as const,
    isGenerating: true,
    projectId,
    generationId,
    title: project.title,
    sceneCount,
    scenes: existingScenes,
    format: project.format as "landscape" | "portrait" | "square",
    statusMessage: phaseLabels[resumeFrom],
    progress: resumeFrom === "audio" ? 10 : resumeFrom === "images" ? 35 : resumeFrom === "video" ? 60 : 96,
    projectType: "cinematic",
  }));

  try {
    // Phase 2: Audio (resume)
    if (resumeFrom === "audio") {
      console.log(LOG, "Resume: starting audio phase");
      const AUDIO_CONCURRENCY = 3;
      const processResumeAudio = async (i: number) => {
        if (existingScenes[i]?.audioUrl) { console.log(LOG, `Resume: skipping audio scene ${i + 1} (done)`); return; }
        ctx.setState((prev) => ({ ...prev, statusMessage: `Resuming audio (${i + 1}/${sceneCount})...`, progress: 10 + Math.floor(((i + 0.25) / sceneCount) * 25) }));
        let audioComplete = false;
        while (!audioComplete) {
          const audioRes = await ctx.callPhase({ phase: "audio", projectId, generationId, sceneIndex: i }, 300000, CINEMATIC_ENDPOINT);
          if (!audioRes.success) throw new Error(audioRes.error || "Audio generation failed");
          if (audioRes.status === "complete") audioComplete = true; else await sleep(1200);
        }
        ctx.setState((prev) => ({ ...prev, progress: 10 + Math.floor(((i + 1) / sceneCount) * 25) }));
      };
      for (let batchStart = 0; batchStart < sceneCount; batchStart += AUDIO_CONCURRENCY) {
        const batch: Promise<void>[] = [];
        for (let i = batchStart; i < Math.min(batchStart + AUDIO_CONCURRENCY, sceneCount); i++) batch.push(processResumeAudio(i));
        await Promise.allSettled(batch);
      }
    }

    // Phase 3+4: Interleaved Image→Video (resume) — same as main pipeline
    if (resumeFrom === "audio" || resumeFrom === "images" || resumeFrom === "video") {
      console.log(LOG, "Resume: starting interleaved image→video phase");
      await runCinematicVisuals(projectId, generationId, sceneCount, ctx);
    }

    // Pre-finalize check
    const { data: preFinalGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
    const preFinalScenes = normalizeScenes(preFinalGen?.scenes) ?? [];
    const stillMissing = preFinalScenes.filter((s) => !s.videoUrl && s.imageUrl).length;
    if (stillMissing > 0) console.warn(LOG, `${stillMissing} scenes still missing after resume retries`);

    // Phase 5: Finalize
    await finalizeCinematic(projectId, generationId, sceneCount, project.format, ctx);

    ctx.toast({ title: "Generation Resumed!", description: `"${project.title}" is ready.` });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Resume failed";
    console.error(LOG, "Resume failed:", errorMessage);
    ctx.setState((prev) => ({ ...prev, step: "error" as const, isGenerating: false, error: errorMessage, statusMessage: errorMessage }));
    ctx.toast({ variant: "destructive", title: "Resume Failed", description: errorMessage });
  }
}
