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
const GLOBAL_COOLDOWN_MS = 30000;

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

  // Phase 2–4
  await runCinematicAudio(projectId, generationId, sceneCount, ctx);
  await runCinematicImages(projectId, generationId, sceneCount, ctx);
  await runCinematicVideo(projectId, generationId, sceneCount, ctx);

  // Phase 5: Finalize
  await finalizeCinematic(projectId, generationId, sceneCount, params.format, ctx);

  ctx.toast({ title: "Cinematic Video Generated!", description: `"${title}" is ready.` });
}

// ---- Sub-Phases ----

async function runCinematicAudio(projectId: string, generationId: string, sceneCount: number, ctx: PipelineContext) {
  console.log(LOG, "Starting audio phase", { sceneCount });

  for (let i = 0; i < sceneCount; i++) {
    ctx.setState((prev) => ({
      ...prev,
      statusMessage: `Generating audio (${i + 1}/${sceneCount})...`,
      progress: 10 + Math.floor(((i + 0.25) / sceneCount) * 25),
    }));

    let audioComplete = false;
    let pollCount = 0;
    while (!audioComplete) {
      pollCount++;
      const audioRes = await ctx.callPhase(
        { phase: "audio", projectId, generationId, sceneIndex: i },
        300000,
        CINEMATIC_ENDPOINT
      );
      if (!audioRes.success) throw new Error(audioRes.error || "Audio generation failed");
      if (audioRes.status === "complete") {
        audioComplete = true;
        console.log(LOG, `Audio scene ${i + 1}/${sceneCount} complete after ${pollCount} poll(s)`);
      } else {
        await sleep(1200);
      }
    }

    ctx.setState((prev) => ({
      ...prev,
      progress: 10 + Math.floor(((i + 1) / sceneCount) * 25),
    }));
  }
  console.log(LOG, "Audio phase complete");
}

async function runCinematicImages(projectId: string, generationId: string, sceneCount: number, ctx: PipelineContext) {
  console.log(LOG, "Starting images phase", { sceneCount });
  ctx.setState((prev) => ({ ...prev, progress: 35, statusMessage: "Audio complete. Creating scene images..." }));

  for (let i = 0; i < sceneCount; i++) {
    ctx.setState((prev) => ({
      ...prev,
      statusMessage: `Creating images (${i + 1}/${sceneCount})...`,
      progress: 35 + Math.floor(((i + 0.25) / sceneCount) * 25),
    }));

    // Respect global rate-limit cooldown before image requests
    const now = Date.now();
    if (now - lastRateLimitTime < GLOBAL_COOLDOWN_MS) {
      const cooldownWait = GLOBAL_COOLDOWN_MS - (now - lastRateLimitTime);
      console.log(LOG, `Image scene ${i + 1}: global cooldown active, waiting ${(cooldownWait / 1000).toFixed(1)}s`);
      await sleep(cooldownWait);
    }

    try {
      const imgRes = await ctx.callPhase(
        { phase: "images", projectId, generationId, sceneIndex: i },
        480000,
        CINEMATIC_ENDPOINT
      );
      if (!imgRes.success) {
        if (imgRes.retryAfterMs && imgRes.retryAfterMs >= 20000) {
          lastRateLimitTime = Date.now();
          console.log(LOG, `Image scene ${i + 1}: rate limited, global cooldown set`);
        }
        console.warn(LOG, `Image scene ${i + 1} failed: ${imgRes.error}`);
      }
    } catch (err) {
      console.warn(LOG, `Image scene ${i + 1} error:`, err);
    }

    ctx.setState((prev) => ({
      ...prev,
      progress: 35 + Math.floor(((i + 1) / sceneCount) * 25),
    }));
  }

  await retryMissingImages(generationId, sceneCount, ctx, projectId);
  console.log(LOG, "Images phase complete");
}

async function runCinematicVideo(projectId: string, generationId: string, sceneCount: number, ctx: PipelineContext) {
  console.log(LOG, "Starting video phase", { sceneCount });
  ctx.setState((prev) => ({ ...prev, progress: 60, statusMessage: "Images complete. Generating video clips..." }));

  const VIDEO_CONCURRENCY = 1;
  let completedVideos = 0;

  const generateVideoForScene = async (sceneIdx: number) => {
    try {
      // Pre-check: skip if video already exists in DB
      const { data: checkGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
      const checkScenes = normalizeScenes(checkGen?.scenes) ?? [];
      if (checkScenes[sceneIdx]?.videoUrl) {
        completedVideos++;
        console.log(LOG, `Video scene ${sceneIdx + 1}: already has videoUrl, skipping`);
        ctx.setState((prev) => ({
          ...prev,
          statusMessage: `Generating clips (${completedVideos}/${sceneCount})...`,
          progress: 60 + Math.floor((completedVideos / sceneCount) * 35),
        }));
        return;
      }

      let videoComplete = false;
      let pollAttempts = 0;
      const MAX_POLL = 180;

      while (!videoComplete) {
        pollAttempts++;
        if (pollAttempts > MAX_POLL) {
          console.warn(LOG, `Video scene ${sceneIdx + 1} timed out after ${MAX_POLL} polls`);
          return;
        }

        // Global cooldown: wait if we recently hit a rate limit
        const now = Date.now();
        if (now - lastRateLimitTime < GLOBAL_COOLDOWN_MS) {
          const cooldownWait = GLOBAL_COOLDOWN_MS - (now - lastRateLimitTime);
          console.log(LOG, `Scene ${sceneIdx + 1}: global cooldown active, waiting ${(cooldownWait / 1000).toFixed(1)}s`);
          await sleep(cooldownWait);
        }

        const vidRes = await ctx.callPhase(
          { phase: "video", projectId, generationId, sceneIndex: sceneIdx },
          480000,
          CINEMATIC_ENDPOINT
        );
        if (!vidRes.success) {
          console.warn(LOG, `Video scene ${sceneIdx + 1} failed: ${vidRes.error}`);
          return;
        }
        if (vidRes.status === "complete") {
          videoComplete = true;
          console.log(LOG, `Video scene ${sceneIdx + 1} complete after ${pollAttempts} poll(s)`);
        } else {
          const waitMs = vidRes.retryAfterMs || 8000;
          if (waitMs >= 20000) {
            lastRateLimitTime = Date.now();
            console.log(LOG, `Scene ${sceneIdx + 1}: rate limited, waiting ${waitMs / 1000}s (global cooldown set)`);
            ctx.setState((prev) => ({
              ...prev,
              statusMessage: `Provider busy. Pausing for ${waitMs / 1000}s (Scene ${sceneIdx + 1})...`,
            }));
          }
          await sleep(waitMs);
          ctx.setState((prev) => ({
            ...prev,
            statusMessage: `Generating clips (${completedVideos}/${sceneCount})...`,
          }));
        }
      }
      completedVideos++;
      ctx.setState((prev) => ({
        ...prev,
        statusMessage: `Generating clips (${completedVideos}/${sceneCount})...`,
        progress: 60 + Math.floor((completedVideos / sceneCount) * 35),
      }));
    } catch (err) {
      console.warn(LOG, `Video scene ${sceneIdx + 1} error:`, err);
    }
  };

  // Process in concurrent batches
  for (let batchStart = 0; batchStart < sceneCount; batchStart += VIDEO_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + VIDEO_CONCURRENCY, sceneCount);
    const batch = [];
    for (let i = batchStart; i < batchEnd; i++) batch.push(generateVideoForScene(i));
    console.log(LOG, `Processing video batch ${batchStart + 1}–${batchEnd}`);
    await Promise.allSettled(batch);
  }

  // FIX 3: Reduced from 2 rounds to 1 to prevent double-billing
  for (let round = 0; round < 1; round++) {
    const { data: latestGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
    const latestScenes = normalizeScenes(latestGen?.scenes) ?? [];
    const missing = latestScenes.map((s, i) => (!s.videoUrl && s.imageUrl ? i : -1)).filter((i) => i >= 0);
    if (missing.length === 0) break;

    console.log(LOG, `Video retry round ${round + 1}: ${missing.length} scenes missing`);
    ctx.setState((prev) => ({ ...prev, statusMessage: `Retrying ${missing.length} missing clips (round ${round + 1})...` }));
    for (const idx of missing) await generateVideoForScene(idx);
  }

  // Final check
  const { data: preFinalGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
  const preFinalScenes = normalizeScenes(preFinalGen?.scenes) ?? [];
  const stillMissing = preFinalScenes.filter((s) => !s.videoUrl && s.imageUrl).length;
  if (stillMissing > 0) console.warn(LOG, `${stillMissing} scenes still missing video – proceeding to finalize`);

  console.log(LOG, "Video phase complete");
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
      for (let i = 0; i < sceneCount; i++) {
        if (existingScenes[i]?.audioUrl) { console.log(LOG, `Resume: skipping audio scene ${i + 1} (done)`); continue; }
        ctx.setState((prev) => ({ ...prev, statusMessage: `Resuming audio (${i + 1}/${sceneCount})...`, progress: 10 + Math.floor(((i + 0.25) / sceneCount) * 25) }));
        let audioComplete = false;
        while (!audioComplete) {
          const audioRes = await ctx.callPhase({ phase: "audio", projectId, generationId, sceneIndex: i }, 300000, CINEMATIC_ENDPOINT);
          if (!audioRes.success) throw new Error(audioRes.error || "Audio generation failed");
          if (audioRes.status === "complete") audioComplete = true; else await sleep(1200);
        }
        ctx.setState((prev) => ({ ...prev, progress: 10 + Math.floor(((i + 1) / sceneCount) * 25) }));
      }
    }

    // Phase 3: Images (resume)
    if (resumeFrom === "audio" || resumeFrom === "images") {
      console.log(LOG, "Resume: starting images phase");
      ctx.setState((prev) => ({ ...prev, progress: 35, statusMessage: "Resuming images..." }));
      for (let i = 0; i < sceneCount; i++) {
        if (existingScenes[i]?.imageUrl) { console.log(LOG, `Resume: skipping image scene ${i + 1} (done)`); continue; }
        ctx.setState((prev) => ({ ...prev, statusMessage: `Creating images (${i + 1}/${sceneCount})...`, progress: 35 + Math.floor(((i + 0.25) / sceneCount) * 25) }));
        // Respect global rate-limit cooldown
        const now = Date.now();
        if (now - lastRateLimitTime < GLOBAL_COOLDOWN_MS) {
          const cooldownWait = GLOBAL_COOLDOWN_MS - (now - lastRateLimitTime);
          console.log(LOG, `Resume image ${i + 1}: global cooldown, waiting ${(cooldownWait / 1000).toFixed(1)}s`);
          await sleep(cooldownWait);
        }
        try {
          const imgRes = await ctx.callPhase({ phase: "images", projectId, generationId, sceneIndex: i }, 480000, CINEMATIC_ENDPOINT);
          if (!imgRes.success) {
            if (imgRes.retryAfterMs && imgRes.retryAfterMs >= 20000) {
              lastRateLimitTime = Date.now();
            }
            console.warn(LOG, `Resume image scene ${i + 1} failed: ${imgRes.error}`);
          }
        } catch (err) {
          console.warn(LOG, `Resume image scene ${i + 1} error:`, err);
        }
        ctx.setState((prev) => ({ ...prev, progress: 35 + Math.floor(((i + 1) / sceneCount) * 25) }));
      }
      await retryMissingImages(generationId, sceneCount, ctx, projectId);
    }

    // Phase 4: Video (resume)
    if (resumeFrom === "audio" || resumeFrom === "images" || resumeFrom === "video") {
      console.log(LOG, "Resume: starting video phase");
      ctx.setState((prev) => ({ ...prev, progress: 60, statusMessage: "Resuming video clips..." }));
      const VIDEO_CONCURRENCY = 1;
      let completedVideos = existingScenes.filter((s) => !!s.videoUrl).length;

      const generateVideoForScene = async (sceneIdx: number) => {
        // Pre-check: skip if video already exists in DB
        const { data: checkGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
        const checkScenes = normalizeScenes(checkGen?.scenes) ?? [];
        if (checkScenes[sceneIdx]?.videoUrl) {
          completedVideos++;
          console.log(LOG, `Resume: video scene ${sceneIdx + 1} already has videoUrl, skipping`);
          ctx.setState((prev) => ({
            ...prev,
            statusMessage: `Generating clips (${completedVideos}/${sceneCount})...`,
            progress: 60 + Math.floor((completedVideos / sceneCount) * 35),
          }));
          return;
        }
        try {
          let videoComplete = false;
          let pollAttempts = 0;
          while (!videoComplete) {
            pollAttempts++;
            if (pollAttempts > 180) { console.warn(LOG, `Resume video scene ${sceneIdx + 1} timed out`); return; }

            // Global cooldown
            const now = Date.now();
            if (now - lastRateLimitTime < GLOBAL_COOLDOWN_MS) {
              const cooldownWait = GLOBAL_COOLDOWN_MS - (now - lastRateLimitTime);
              console.log(LOG, `Resume scene ${sceneIdx + 1}: global cooldown, waiting ${(cooldownWait / 1000).toFixed(1)}s`);
              await sleep(cooldownWait);
            }

            const vidRes = await ctx.callPhase({ phase: "video", projectId, generationId, sceneIndex: sceneIdx }, 480000, CINEMATIC_ENDPOINT);
            if (!vidRes.success) { console.warn(LOG, `Resume video scene ${sceneIdx + 1} failed: ${vidRes.error}`); return; }
            if (vidRes.status === "complete") {
              videoComplete = true;
            } else {
              const waitMs = vidRes.retryAfterMs || 8000;
              if (waitMs >= 20000) {
                lastRateLimitTime = Date.now();
                console.log(LOG, `Resume scene ${sceneIdx + 1}: rate limited, waiting ${waitMs / 1000}s (global cooldown set)`);
                ctx.setState((prev) => ({
                  ...prev,
                  statusMessage: `Provider busy. Pausing for ${waitMs / 1000}s (Scene ${sceneIdx + 1})...`,
                }));
              }
              await sleep(waitMs);
              ctx.setState((prev) => ({
                ...prev,
                statusMessage: `Generating clips (${completedVideos}/${sceneCount})...`,
              }));
            }
          }
          completedVideos++;
          ctx.setState((prev) => ({ ...prev, statusMessage: `Generating clips (${completedVideos}/${sceneCount})...`, progress: 60 + Math.floor((completedVideos / sceneCount) * 35) }));
        } catch (err) {
          console.warn(LOG, `Resume video scene ${sceneIdx + 1} error:`, err);
        }
      };

      for (let batchStart = 0; batchStart < sceneCount; batchStart += VIDEO_CONCURRENCY) {
        const batch = [];
        for (let i = batchStart; i < Math.min(batchStart + VIDEO_CONCURRENCY, sceneCount); i++) batch.push(generateVideoForScene(i));
        await Promise.allSettled(batch);
      }

      // Retry pass
      // FIX 3: Reduced from 2 rounds to 1
      for (let round = 0; round < 1; round++) {
        const { data: latestGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
        const latestScenes = normalizeScenes(latestGen?.scenes) ?? [];
        const missing = latestScenes.map((s, i) => (!s.videoUrl && s.imageUrl ? i : -1)).filter((i) => i >= 0);
        if (missing.length === 0) break;
        console.log(LOG, `Resume video retry round ${round + 1}: ${missing.length} missing`);
        ctx.setState((prev) => ({ ...prev, statusMessage: `Retrying ${missing.length} missing clips (round ${round + 1})...` }));
        for (const idx of missing) await generateVideoForScene(idx);
      }
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
