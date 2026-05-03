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
import { updateSceneField, updateSceneFieldJson } from "../lib/sceneUpdate.js";
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

  // Branch-routing diagnostic — captured BEFORE any other work so a
  // single grep ("[RegenerateImage] route=") on a job's logs answers
  // "did this go through nano-banana-pro-edit, or did it fall through
  // to a full regen?" The user-reported case where an edit produced a
  // completely different image is exactly the symptom we get when
  // imageModification arrives empty (the regen branch fires text-to-
  // image with the scene's full visualPrompt) — so log the field
  // length plus the chosen route up front.
  const route = imageModification ? "edit" : "regen";
  console.log(
    `[RegenerateImage] route=${route} sceneIdx=${sceneIndex} imgIdx=${targetImageIndex} ` +
    `modLen=${imageModification.length} jobId=${jobId.substring(0, 8)}`
  );

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "regenerate_image_started",
    message: `Regenerating scene ${sceneIndex + 1} image ${targetImageIndex + 1}${imageModification ? " (edit)" : ""}`,
    details: { route, imageModificationLen: imageModification.length },
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

    // Hard-coded edit guard — explicitly tell the model to PRESERVE
    // the source image and apply only the user's change. Without this
    // the model was treating short instructions ("change the title to
    // gold") as standalone generation prompts and producing a
    // completely fresh image. The variable is the user's textbox
    // input verbatim; everything else is the guardrail.
    const editInstruction = `EDIT THE IMAGE, DO NOT CHANGE THE IMAGE, JUST EDIT IT AND ${imageModification}`;
    console.log(`[RegenerateImage] edit prompt (${editInstruction.length} chars): "${editInstruction.substring(0, 200)}"`);

    imageUrl = await editImageWithNanoBanana(
      sourceImageUrl,
      editInstruction,
      hyperealApiKey,
      aspectRatio,
      undefined,
      projectId,
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

  // Compute the new imageUrls array from the (possibly stale) in-memory
  // snapshot — it's fine for this array slot because we only change
  // index `targetImageIndex` relative to what existed when the job
  // started, and concurrent jobs wouldn't be writing the same slot.
  const existingUrls: (string | null)[] =
    Array.isArray(scene.imageUrls) && scene.imageUrls.length > 0
      ? [...scene.imageUrls]
      : scene.imageUrl ? [scene.imageUrl] : [];

  let nextImageUrls: (string | null)[];
  if (existingUrls.length > 0) {
    existingUrls[targetImageIndex] = imageUrl;
    nextImageUrls = existingUrls;
  } else {
    nextImageUrls = [imageUrl];
  }

  // Atomic per-field writes via jsonb_set RPCs. Replaces the legacy
  // read-modify-write on the whole scenes array — that pattern would
  // clobber any concurrent scene update (cinematic_video auto-chain,
  // another regen, master_audio) that landed during Hypereal's 20–60s
  // generation window. Matches handleCinematicImage's write pattern.
  await updateSceneFieldJson(generationId, sceneIndex, "imageUrls", nextImageUrls);
  if (targetImageIndex === 0 || existingUrls.length === 0) {
    await updateSceneField(generationId, sceneIndex, "imageUrl", imageUrl);
  }

  // Opportunistic thumbnail — see handleCinematicImage for the rationale.
  // First-image-wins via "WHERE thumbnail_url IS NULL" guard so we never
  // overwrite an existing thumbnail when a user regenerates a later scene.
  await supabase
    .from("projects")
    .update({ thumbnail_url: imageUrl } as never)
    .eq("id", projectId)
    .is("thumbnail_url", null);

  // Track which scenes' videos were stale-by-this-edit, plus their
  // PRE-clear videoUrls so the auto-chain below can route between
  //   • cinematic_video_edit  (text-prompt edit on the existing clip
  //     via grok-imagine-video-edit) — only valid when the user typed
  //     an `imageModification` we can forward as the edit prompt AND
  //     a source videoUrl actually exists.
  //   • cinematic_video       (full Kling V3 Pro re-render) — fallback
  //     for plain regenerations where there's no instruction to feed
  //     into a video edit.
  //
  // Capture URLs FIRST, then clear, so we don't race the auto-chain.
  const prevIndex = sceneIndex - 1;
  const currentSourceVideoUrl: string | null = scenes[sceneIndex]?.videoUrl ?? null;
  const prevSourceVideoUrl: string | null = prevIndex >= 0 ? (scenes[prevIndex]?.videoUrl ?? null) : null;
  const prevHasVideo = prevSourceVideoUrl !== null;
  if (scenes[sceneIndex]?.videoUrl) {
    console.log(`[RegenerateImage] Clearing stale videoUrl for scene ${sceneIndex + 1}`);
    await updateSceneFieldJson(generationId, sceneIndex, "videoUrl", null);
    await updateSceneFieldJson(generationId, sceneIndex, "videoPredictionId", null);
  }
  if (prevHasVideo) {
    console.log(`[RegenerateImage] Clearing stale videoUrl for previous scene ${prevIndex + 1} (its end-frame transition uses this image)`);
    await updateSceneFieldJson(generationId, prevIndex, "videoUrl", null);
    await updateSceneFieldJson(generationId, prevIndex, "videoPredictionId", null);
  }

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "regenerate_image_completed",
    message: `Scene ${sceneIndex + 1} image ${targetImageIndex + 1} regenerated successfully`,
  });

  console.log(`[RegenerateImage] Scene ${sceneIndex + 1} img ${targetImageIndex + 1}: ${imageUrl.substring(0, 80)}`);

  // ── Auto-chain (LEGACY regenAffectedVideos logic): after a
  // cinematic primary-image regen, queue video re-renders for every
  // scene whose video was just invalidated:
  //   - THIS scene (its video's first frame changed)
  //   - PREVIOUS scene (its video's end-frame transition used this
  //     image). First scene (sceneIndex===0) has no previous and
  //     gets skipped; last scene works normally (just one affected).
  //
  // Each queue is wrapped in its own try/catch so one failure doesn't
  // nuke the other. Image regen itself still returns success.
  try {
    const { data: proj } = await supabase
      .from("projects")
      .select("project_type")
      .eq("id", projectId)
      .maybeSingle();
    const isCinematic = proj?.project_type === "cinematic";
    if (isCinematic && targetImageIndex === 0 && userId) {
      // Decide between two routing modes:
      //   EDIT mode  → user supplied an imageModification AND we
      //                captured a source videoUrl for the affected
      //                scene. Queue cinematic_video_edit so Grok
      //                Imagine modifies the existing clip in place.
      //                ~55 credits / $0.55 per edit, ~30s round-trip.
      //   REGEN mode → no instruction or no prior videoUrl. Fall back
      //                to the historical cinematic_video full re-render
      //                path (Kling V3 Pro image-to-video). ~70 credits
      //                / $0.70+, ~30-60s per scene.
      //
      // Per-scene routing is independent — it's possible (e.g. for the
      // first scene) that current has a video but prev doesn't.
      type ChainRow = {
        idx: number;
        sourceVideoUrl: string | null;
        reason: string;
      };
      const affected: ChainRow[] = [];
      if (scenes[sceneIndex]) {
        affected.push({
          idx: sceneIndex,
          sourceVideoUrl: currentSourceVideoUrl,
          reason: "scene-image-changed",
        });
      }
      if (prevIndex >= 0 && scenes[prevIndex]) {
        affected.push({
          idx: prevIndex,
          sourceVideoUrl: prevSourceVideoUrl,
          reason: "prev-scene-end-frame-changed",
        });
      }

      const editPrompt = imageModification.trim();
      const inserts = affected.map((row) => {
        const useEditPath = !!editPrompt && !!row.sourceVideoUrl;
        if (useEditPath) {
          return {
            user_id: userId,
            project_id: projectId,
            task_type: "cinematic_video_edit" as const,
            payload: {
              generationId,
              projectId,
              sceneIndex: row.idx,
              sourceVideoUrl: row.sourceVideoUrl,
              editPrompt,
              regenerate: true,
              _chainedFromImage: true,
              _reason: row.reason,
            },
            status: "pending",
          };
        }
        return {
          user_id: userId,
          project_id: projectId,
          task_type: "cinematic_video" as const,
          payload: {
            generationId,
            projectId,
            sceneIndex: row.idx,
            regenerate: true,
            _chainedFromImage: true,
            _reason: row.reason,
          },
          status: "pending",
        };
      });

      if (inserts.length > 0) {
        try {
          const { error: chainErr } = await supabase
            .from("video_generation_jobs")
            .insert(inserts);
          if (chainErr) {
            console.warn(`[RegenerateImage] Auto-chain batch insert failed (non-fatal): ${chainErr.message}`);
          } else {
            const editCount = inserts.filter(r => r.task_type === "cinematic_video_edit").length;
            const regenCount = inserts.length - editCount;
            console.log(
              `[RegenerateImage] Auto-queued ${inserts.length} jobs in parallel: ` +
              `${editCount} edit, ${regenCount} regen, scenes [${affected.map(r => r.idx + 1).join(", ")}]`,
            );
          }
        } catch (queueErr) {
          const qm = queueErr instanceof Error ? queueErr.message : String(queueErr);
          console.warn(`[RegenerateImage] Auto-chain threw (non-fatal): ${qm}`);
        }
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
