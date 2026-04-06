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
import { createScopedLogger } from "@/lib/logger";

const log = createScopedLogger("CinematicPipeline");

// Global rate-limit cooldown shared across image and video phases
let lastRateLimitTime = 0;
const GLOBAL_COOLDOWN_MS = 15000;

// ---- Main Pipeline ----

/** Execute the full cinematic pipeline from scratch */
export async function runCinematicPipeline(
  params: GenerationParams,
  ctx: PipelineContext
): Promise<void> {
  log.debug("Starting cinematic pipeline", { format: params.format, length: params.length, style: params.style });

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

  log.debug("Script phase complete", { projectId, generationId, sceneCount, title });

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

  // Phase 2+3: Audio AND Images in PARALLEL (they don't depend on each other)
  // Audio needs: voiceover text + language
  // Images need: visualPrompt + style
  // Videos need: images (so they wait for images, but audio runs alongside)
  log.debug("Starting audio + images in parallel");
  const audioPromise = runCinematicAudio(projectId, generationId, sceneCount, ctx, params.language);
  const visualsPromise = runCinematicVisuals(projectId, generationId, sceneCount, ctx);
  await Promise.all([audioPromise, visualsPromise]);

  // Phase 4: Finalize
  await finalizeCinematic(projectId, generationId, sceneCount, params.format, ctx);

  ctx.toast({ title: "Cinematic Video Generated!", description: `"${title}" is ready.` });
}

// ---- Sub-Phases ----

async function runCinematicAudio(projectId: string, generationId: string, sceneCount: number, ctx: PipelineContext, language?: string) {
  log.debug("Starting audio phase", { sceneCount });

  const AUDIO_CONCURRENCY = 5;

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
    log.debug(`Audio scene ${i + 1}/${sceneCount} complete`);

    ctx.setState((prev) => ({
      ...prev,
      progress: 10 + Math.floor(((i + 1) / sceneCount) * 25),
    }));
  };

  for (let batchStart = 0; batchStart < sceneCount; batchStart += AUDIO_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + AUDIO_CONCURRENCY, sceneCount);
    const batch: Promise<void>[] = [];
    for (let i = batchStart; i < batchEnd; i++) batch.push(processAudioScene(i));
    log.debug(`Processing audio batch ${batchStart + 1}–${batchEnd}`);
    const results = await Promise.allSettled(batch);
    const failures = results.filter(r => r.status === "rejected");
    if (failures.length > 0) {
      log.warn(`${failures.length}/${batch.length} audio scenes failed`, {
        errors: failures.map(f => (f as PromiseRejectedResult).reason?.message),
      });
    }
    if (failures.length === batch.length) {
      throw new Error(`All ${batch.length} audio scenes failed in batch`);
    }
  }
  log.debug("Audio phase complete");
}

/** Streaming visuals: images and videos overlap. Each scene's video fires
 *  as soon as its image (+ next scene's image) is ready. No batching —
 *  Kling jobs are remote API calls, not local CPU.
 */
async function runCinematicVisuals(projectId: string, generationId: string, sceneCount: number, ctx: PipelineContext) {
  log.debug("Starting streaming visuals: images → videos", { sceneCount });
  ctx.setState((prev) => ({ ...prev, progress: 35, statusMessage: "Generating images & video clips..." }));

  let completedImages = 0;
  let completedVideos = 0;

  // Track which scenes have images ready
  const imageReady: boolean[] = new Array(sceneCount).fill(false);
  const imageResolvers: Array<() => void> = [];
  const imagePromises: Promise<void>[] = [];
  for (let i = 0; i < sceneCount; i++) {
    imagePromises.push(new Promise<void>((resolve) => { imageResolvers.push(resolve); }));
  }

  // ── Generate images (all in parallel) ──────────────────────────
  const processImage = async (i: number) => {
    const now = Date.now();
    if (now - lastRateLimitTime < GLOBAL_COOLDOWN_MS) {
      await sleep(GLOBAL_COOLDOWN_MS - (now - lastRateLimitTime));
    }
    try {
      const r = await ctx.callPhase(
        { phase: "images", projectId, generationId, sceneIndex: i },
        480000, CINEMATIC_ENDPOINT
      );
      if (!r.success) {
        if (r.retryAfterMs && r.retryAfterMs >= 20000) lastRateLimitTime = Date.now();
        log.warn(`Scene ${i + 1} image failed: ${r.error}`);
      }
    } catch (err) {
      log.warn(`Scene ${i + 1} image error:`, err);
    }
    completedImages++;
    imageReady[i] = true;
    imageResolvers[i]();
    ctx.setState((prev) => ({
      ...prev,
      completedImages,
      totalImages: sceneCount,
      statusMessage: `Images ${completedImages}/${sceneCount} | Clips ${completedVideos}/${sceneCount}`,
      progress: 35 + Math.floor(((completedImages + completedVideos) / (sceneCount * 2)) * 55),
    }));
  };

  // ── Generate videos (streams behind images) ────────────────────
  const processVideo = async (i: number) => {
    // Wait for this scene's image
    await imagePromises[i];
    // Wait for next scene's image too (needed for end_image transition)
    if (i < sceneCount - 1) await imagePromises[i + 1];

    try {
      // Check if already has video
      const { data: g } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
      if ((normalizeScenes(g?.scenes) ?? [])[i]?.videoUrl) {
        log.debug(`Scene ${i + 1}: already has videoUrl, skipping`);
        completedVideos++;
        return;
      }
      const r = await ctx.callPhase(
        { phase: "video", projectId, generationId, sceneIndex: i },
        20 * 60 * 1000, CINEMATIC_ENDPOINT
      );
      if (!r.success) log.warn(`Scene ${i + 1} video failed: ${r.error}`);
    } catch (err) {
      log.warn(`Scene ${i + 1} video error:`, err);
    }
    completedVideos++;
    ctx.setState((prev) => ({
      ...prev,
      statusMessage: `Images ${completedImages}/${sceneCount} | Clips ${completedVideos}/${sceneCount}`,
      progress: 35 + Math.floor(((completedImages + completedVideos) / (sceneCount * 2)) * 55),
    }));
  };

  // Fire ALL images and ALL videos simultaneously
  // Videos will self-throttle by waiting on their image dependencies
  const allPromises: Promise<void>[] = [];
  for (let i = 0; i < sceneCount; i++) allPromises.push(processImage(i));
  for (let i = 0; i < sceneCount; i++) allPromises.push(processVideo(i));
  log.debug(`Dispatched ${sceneCount} images + ${sceneCount} videos (streaming)`);
  await Promise.allSettled(allPromises);

  // Retry missing images (1 round, parallel)
  await retryMissingImages(generationId, sceneCount, ctx, projectId);

  // Retry missing videos (1 round, ALL in parallel)
  const { data: latestGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
  const latestScenes = normalizeScenes(latestGen?.scenes) ?? [];
  const missingVids = latestScenes.map((s, i) => (!s.videoUrl ? i : -1)).filter((i) => i >= 0);
  if (missingVids.length > 0) {
    log.debug(`Retrying ${missingVids.length} missing videos in parallel`);
    ctx.setState((prev) => ({ ...prev, statusMessage: `Retrying ${missingVids.length} missing clips...` }));
    await Promise.allSettled(
      missingVids.map((idx) =>
        ctx.callPhase({ phase: "video", projectId, generationId, sceneIndex: idx }, 20 * 60 * 1000, CINEMATIC_ENDPOINT)
          .catch(() => {})
      )
    );
  }

  log.debug("Visuals phase complete");
}

async function finalizeCinematic(projectId: string, generationId: string, sceneCount: number, format: string, ctx: PipelineContext) {
  log.debug("Starting finalize phase");
  ctx.setState((prev) => ({ ...prev, step: "rendering" as const, progress: 96, statusMessage: "Finalizing cinematic..." }));

  const finalRes = await ctx.callPhase(
    { phase: "finalize", projectId, generationId },
    120000,
    CINEMATIC_ENDPOINT
  );
  if (!finalRes.success) throw new Error(finalRes.error || "Finalization failed");

  const finalScenes = normalizeScenes(finalRes.scenes);
  log.debug("Cinematic pipeline complete", { sceneCount: finalScenes?.length, title: finalRes.title });

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

    log.debug(`Image retry round ${round + 1}: ${missing.length} scenes missing`);
    ctx.setState((prev) => ({ ...prev, statusMessage: `Retrying ${missing.length} missing images (round ${round + 1})...` }));

    for (const idx of missing) {
      // Respect global rate-limit cooldown
      const now = Date.now();
      if (now - lastRateLimitTime < GLOBAL_COOLDOWN_MS) {
        const cooldownWait = GLOBAL_COOLDOWN_MS - (now - lastRateLimitTime);
        log.debug(`Image retry ${idx + 1}: global cooldown, waiting ${(cooldownWait / 1000).toFixed(1)}s`);
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

  log.debug(`Resuming cinematic from "${resumeFrom}"`, { projectId, generationId, sceneCount });

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
      log.debug("Resume: starting audio phase");
      const AUDIO_CONCURRENCY = 5;
      const processResumeAudio = async (i: number) => {
        if (existingScenes[i]?.audioUrl) { log.debug(`Resume: skipping audio scene ${i + 1} (done)`); return; }
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
        const results = await Promise.allSettled(batch);
        const failures = results.filter(r => r.status === "rejected");
        if (failures.length > 0) {
          log.warn(`Resume: ${failures.length}/${batch.length} audio scenes failed`, {
            errors: failures.map(f => (f as PromiseRejectedResult).reason?.message),
          });
        }
        if (failures.length === batch.length) {
          throw new Error(`All ${batch.length} audio scenes failed in resume batch`);
        }
      }
    }

    // Phase 3+4: Interleaved Image→Video (resume) — same as main pipeline
    if (resumeFrom === "audio" || resumeFrom === "images" || resumeFrom === "video") {
      log.debug("Resume: starting interleaved image→video phase");
      await runCinematicVisuals(projectId, generationId, sceneCount, ctx);
    }

    // Pre-finalize check
    const { data: preFinalGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
    const preFinalScenes = normalizeScenes(preFinalGen?.scenes) ?? [];
    const stillMissing = preFinalScenes.filter((s) => !s.videoUrl && s.imageUrl).length;
    if (stillMissing > 0) log.warn(`${stillMissing} scenes still missing after resume retries`);

    // Phase 5: Finalize
    await finalizeCinematic(projectId, generationId, sceneCount, project.format, ctx);

    ctx.toast({ title: "Generation Resumed!", description: `"${project.title}" is ready.` });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Resume failed";
    log.error("Resume failed:", errorMessage);
    ctx.setState((prev) => ({ ...prev, step: "error" as const, isGenerating: false, error: errorMessage, statusMessage: errorMessage }));
    ctx.toast({ variant: "destructive", title: "Resume Failed", description: errorMessage });
  }
}
