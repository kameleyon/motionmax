# Unified Generation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the standard and cinematic generation pipelines into a single pipeline that uses per-scene jobs with atomic DB updates for all 4 project types, eliminating code duplication and race conditions.

**Architecture:** One frontend pipeline dispatcher (`unifiedPipeline.ts`) replaces both `standardPipeline.ts` and `cinematicPipeline.ts`. One worker audio handler (`handleAudio.ts`) replaces both the current standard and cinematic audio handlers. One worker image handler (`handleImages.ts`) replaces both. The only branch point is cinematic's video generation step (skipped for other types). `callPhase.ts` simplified to always dispatch per-scene jobs.

**Tech Stack:** TypeScript, React hooks, Supabase (Postgres jsonb_set via RPC), Qwen3 TTS (Replicate), Hypereal (images/video), FFmpeg (export)

---

## File Structure

### Files to Create
- `src/hooks/generation/unifiedPipeline.ts` — single pipeline for all 4 project types

### Files to Modify
- `src/hooks/generation/callPhase.ts` — simplify routing (remove standard/cinematic split)
- `src/hooks/useGenerationPipeline.ts` — route all types through unified pipeline
- `worker/src/index.ts` — consolidate job type routing
- `worker/src/handlers/handleAudio.ts` — already uses Qwen3+atomic (keep as-is, minor cleanup)
- `worker/src/handlers/handleImages.ts` — switch to atomic `updateSceneField` per image

### Files to Delete (after migration)
- `src/hooks/generation/standardPipeline.ts`
- `src/hooks/generation/cinematicPipeline.ts`
- `worker/src/handlers/handleCinematicAudio.ts`
- `worker/src/handlers/handleCinematicImage.ts`

### Files Unchanged
- `worker/src/handlers/handleCinematicVideo.ts` — cinematic-only, no standard equivalent
- `worker/src/handlers/handleFinalize.ts` — already shared
- `worker/src/handlers/exportVideo.ts` — already shared
- `worker/src/handlers/generateVideo.ts` — already shared (script phase)

---

### Task 1: Create Unified Frontend Pipeline

**Files:**
- Create: `src/hooks/generation/unifiedPipeline.ts`
- Modify: `src/hooks/generation/callPhase.ts`

**Summary:** The unified pipeline handles all 4 project types with this flow:
```
script → audio (per-scene, batch 5) + images (per-scene, all parallel) → video (cinematic only, streaming) → finalize
```

- [ ] **Step 1: Create `src/hooks/generation/unifiedPipeline.ts`**

The pipeline logic:
1. **Script phase** — same for all types, just different endpoint for cinematic
2. **Audio + Images in parallel** — both dispatch per-scene jobs (not bulk batch jobs)
   - Audio: batch 5 scenes, each scene = one `cinematic_audio` job
   - Images: all scenes in parallel, each scene = one `cinematic_image` job
3. **Video phase** (cinematic only) — streaming: fire video jobs as images complete
4. **Finalize** — same for all types

Key differences from current:
- Standard types currently use `process_audio` (bulk) and `process_images` (bulk). Unified uses per-scene jobs for everything (same as cinematic).
- SmartFlow has 1 scene, so per-scene dispatch = 1 audio job + 1 image job. Same behavior, cleaner code.
- doc2video/storytelling have 15-36 scenes. Per-scene dispatch = more jobs but atomic updates, no race conditions.

```typescript
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
      const batch: Promise<any>[] = [];
      for (let i = batchStart; i < batchEnd; i++) {
        batch.push(
          ctx.callPhase({ phase: "audio", projectId, generationId, sceneIndex: i, language: params.language }, 300000, endpoint)
            .catch((err) => { log.warn(`Audio scene ${i} failed:`, err); return { success: false }; })
        );
      }
      const results = await Promise.allSettled(batch);
      const failures = results.filter(r => r.status === "rejected");
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
  const imagePromises: Promise<any>[] = [];
  const videoPromises: Promise<any>[] = []; // cinematic only

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
    ).then((result) => {
      if (isCinematic && imageResolvers[i]) imageResolvers[i]();
      ctx.setState((prev) => ({
        ...prev,
        completedImages: (prev.completedImages || 0) + 1,
        progress: Math.min(89, 35 + Math.floor(((prev.completedImages || 0) + 1) / sceneCount * 50)),
        statusMessage: `Images ${(prev.completedImages || 0) + 1}/${sceneCount}...`,
      }));
      return result;
    }).catch((err) => {
      log.warn(`Image scene ${i} failed:`, err);
      if (isCinematic && imageResolvers[i]) imageResolvers[i](); // unblock video even on failure
      return { success: false };
    });

    imagePromises.push(imagePromise);

    // Cinematic: fire video jobs as images complete (streaming)
    if (isCinematic) {
      const videoPromise = (async () => {
        // Wait for current scene image + next scene image (for transition)
        await imageReady[i];
        if (i < sceneCount - 1) await imageReady[i + 1];

        return ctx.callPhase(
          { phase: "video", projectId, generationId, sceneIndex: i },
          20 * 60 * 1000, endpoint
        ).then((result) => {
          ctx.setState((prev) => ({
            ...prev,
            statusMessage: `Video ${i + 1}/${sceneCount}...`,
          }));
          return result;
        }).catch((err) => {
          log.warn(`Video scene ${i} failed:`, err);
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
          .catch((err) => log.warn(`Image retry scene ${i} failed:`, err))
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
            .catch((err) => log.warn(`Video retry scene ${i} failed:`, err))
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
```

- [ ] **Step 2: Simplify `callPhase.ts` routing**

Remove the standard/cinematic split for audio and images. All audio jobs use `cinematic_audio` job type (it handles single scenes). All image jobs use `cinematic_image` job type.

In `src/hooks/generation/callPhase.ts`, replace the routing section after the phase guard:

```typescript
  // Audio — always per-scene (unified)
  if (body.phase === "audio") {
    return workerCallPhase(body, "cinematic_audio", timeoutMs || 300000);
  }

  // Images — always per-scene (unified)
  if (body.phase === "images") {
    return workerCallPhase(body, "cinematic_image", timeoutMs || 300000);
  }

  // Video — cinematic only, per-scene
  if (body.phase === "video") {
    return workerCallPhase(body, "cinematic_video", 10 * 60 * 1000);
  }

  // Finalize
  if (body.phase === "finalize") {
    return workerCallPhase(body, "finalize_generation", 2 * 60 * 1000);
  }
```

Remove the old `process_audio` and `process_images` routes.

- [ ] **Step 3: Run `npx tsc -p tsconfig.app.json --noEmit` to verify**

Expected: zero errors

- [ ] **Step 4: Commit**

```bash
git add src/hooks/generation/unifiedPipeline.ts src/hooks/generation/callPhase.ts
git commit -m "feat: create unified pipeline dispatcher for all project types"
```

---

### Task 2: Wire Unified Pipeline Into useGenerationPipeline

**Files:**
- Modify: `src/hooks/useGenerationPipeline.ts`

- [ ] **Step 1: Replace pipeline routing**

In `useGenerationPipeline.ts`, find where it routes to `runStandardPipeline` or `runCinematicPipeline` based on project type. Replace with a single call to `runUnifiedPipeline`.

```typescript
import { runUnifiedPipeline } from "./generation/unifiedPipeline";

// Replace the existing pipeline routing logic:
// BEFORE: if (projectType === "cinematic") runCinematicPipeline(...) else runStandardPipeline(...)
// AFTER:
await runUnifiedPipeline(params, ctx, expectedSceneCount);
```

Remove imports of `runStandardPipeline` and `runCinematicPipeline`.

- [ ] **Step 2: Run `npx tsc -p tsconfig.app.json --noEmit` to verify**

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useGenerationPipeline.ts
git commit -m "feat: route all project types through unified pipeline"
```

---

### Task 3: Switch Worker Images Handler to Atomic Updates

**Files:**
- Modify: `worker/src/handlers/handleImages.ts`

The current `handleImages.ts` does full-array DB overwrites after each image. The cinematic handler (`handleCinematicImage.ts`) uses `updateSceneField` for atomic updates. Switch `handleImages.ts` to the same pattern.

- [ ] **Step 1: Replace DB write pattern in handleImages.ts**

After each image completes, instead of reading fresh scenes and merging:

```typescript
// BEFORE (race-prone merge):
const { data: freshGen } = await supabase.from("generations").select("scenes").eq("id", generationId).maybeSingle();
const mergedScenes = scenes.map((s, i) => ({ ...s, audioUrl: freshGen?.scenes[i]?.audioUrl, ... }));
await supabase.from("generations").update({ scenes: mergedScenes }).eq("id", generationId);

// AFTER (atomic per-field):
import { updateSceneField } from "../lib/sceneUpdate.js";

// When image URL generated:
await updateSceneField(generationId, sceneIndex, "imageUrl", url);
// When imageUrls array updated:
await updateSceneField(generationId, sceneIndex, "imageUrls", JSON.stringify(subs));
```

Remove all full-array scene overwrites. Progress updates can still update `video_generation_jobs.progress` without touching `generations.scenes`.

- [ ] **Step 2: Run `cd worker && npx tsc --noEmit` to verify**

- [ ] **Step 3: Commit**

```bash
git add worker/src/handlers/handleImages.ts
git commit -m "refactor: switch images handler to atomic updateSceneField"
```

---

### Task 4: Consolidate Worker Job Type Routing

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Remove dead job types from worker routing**

In `worker/src/index.ts`, the `process_audio` and `process_images` job types are no longer dispatched by the unified pipeline. Keep the handlers temporarily for in-flight jobs, but add deprecation logging:

```typescript
} else if (job.task_type === 'process_audio' as any) {
  console.warn("[Worker] DEPRECATED: process_audio job type — should use cinematic_audio");
  const audioResult = await handleAudioPhase(job.id, job.payload as any, job.user_id);
  finalPayload = { ...finalPayload, ...audioResult };
} else if (job.task_type === 'process_images' as any) {
  console.warn("[Worker] DEPRECATED: process_images job type — should use cinematic_image");
  const imagesResult = await handleImagesPhase(job.id, job.payload as any, job.user_id);
  finalPayload = { ...finalPayload, ...imagesResult };
}
```

- [ ] **Step 2: Run `cd worker && npx tsc --noEmit` to verify**

- [ ] **Step 3: Commit**

```bash
git add worker/src/index.ts
git commit -m "refactor: deprecate process_audio/process_images job types"
```

---

### Task 5: Delete Old Pipeline Files

**Files:**
- Delete: `src/hooks/generation/standardPipeline.ts`
- Delete: `src/hooks/generation/cinematicPipeline.ts`

- [ ] **Step 1: Verify no imports remain**

```bash
grep -r "standardPipeline\|cinematicPipeline" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".claude/"
```

Expected: zero results (after Task 2 removed the imports)

- [ ] **Step 2: Delete files**

```bash
rm src/hooks/generation/standardPipeline.ts
rm src/hooks/generation/cinematicPipeline.ts
```

- [ ] **Step 3: Run `npx tsc -p tsconfig.app.json --noEmit` to verify**

- [ ] **Step 4: Commit**

```bash
git commit -m "cleanup: remove old standard and cinematic pipeline files"
```

---

### Task 6: Delete Old Cinematic Audio/Image Handlers (After Soak Period)

**Files:**
- Delete: `worker/src/handlers/handleCinematicAudio.ts`
- Delete: `worker/src/handlers/handleCinematicImage.ts`
- Modify: `worker/src/index.ts` — route `cinematic_audio` and `cinematic_image` to the unified handlers

**NOTE:** Do this AFTER deploying Tasks 1-5 and verifying no issues in production. The cinematic handlers are the proven working ones — if anything breaks in the unified handlers, we want the ability to roll back.

- [ ] **Step 1: In `worker/src/index.ts`, route cinematic job types to the shared handlers**

```typescript
// cinematic_audio → same handler as process_audio (handleAudioPhase)
// The handler already supports sceneIndex-based single-scene processing
} else if (job.task_type === 'cinematic_audio' as any) {
  const result = await handleAudioPhase(job.id, job.payload as any, job.user_id);
  finalPayload = { ...finalPayload, ...result };
}

// cinematic_image → shared image handler (per-scene mode)
} else if (job.task_type === 'cinematic_image' as any) {
  const result = await handleImagesPhase(job.id, job.payload as any, job.user_id);
  finalPayload = { ...finalPayload, ...result };
}
```

- [ ] **Step 2: Delete old cinematic handlers**

```bash
rm worker/src/handlers/handleCinematicAudio.ts
rm worker/src/handlers/handleCinematicImage.ts
```

- [ ] **Step 3: Remove imports from `worker/src/index.ts`**

- [ ] **Step 4: Run `cd worker && npx tsc --noEmit` to verify**

- [ ] **Step 5: Commit**

```bash
git commit -m "cleanup: remove cinematic audio/image handlers, use unified handlers"
```

---

## Notes

- **SmartFlow** (1 scene): The per-scene approach means 1 audio job + 1 image job. No batch overhead.
- **doc2video/storytelling** (15-36 scenes): More individual jobs but each is atomic. The AUDIO_CONCURRENCY=5 cap prevents overwhelming the worker.
- **Cinematic** (12-36 scenes): Same streaming video pattern preserved. The image→video dependency chain works identically.
- **handleCinematicVideo.ts** stays as-is — it's cinematic-specific with no standard equivalent.
- **handleFinalize.ts** stays as-is — already shared.
- **exportVideo.ts** stays as-is — already shared.
