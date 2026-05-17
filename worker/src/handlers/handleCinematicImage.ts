import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { audit, auditError } from "../lib/audit.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { retryDbRead } from "../lib/retryClassifier.js";
import { generateImage } from "../services/imageGenerator.js";
import { buildImagePrompt, type Scene as ImageScene } from "../services/imagePromptBuilder.js";
import {
  initSceneProgress,
  updateSceneProgress,
  flushSceneProgress,
  clearSceneProgress,
} from "../lib/sceneProgress.js";

interface CinematicImagePayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
}

export async function handleCinematicImage(
  jobId: string,
  payload: CinematicImagePayload,
  userId?: string
) {
  const { generationId, projectId, sceneIndex } = payload;

  // Phase 17.3 kill-switch — admin pauses image generation.
  const { isKillSwitchArmed } = await import("../lib/featureFlags.js");
  // Renamed 2026-05-08 from "image_generation" → "pause_image" to
  // avoid collision with the legacy positive-semantic feature flag
  // of the same name (which the imageGenerator service still reads
  // via isEnabled). See migration 20260508240000.
  if (await isKillSwitchArmed("pause_image")) {
    throw new Error("Image generation is paused by an administrator (kill switch: pause_image).");
  }

  await audit("image.gen_started", {
    jobId, projectId, userId, generationId,
    message: `Cinematic image started for scene ${sceneIndex}`,
    details: { sceneIndex },
  });

  try {
    return await _runCinematicImage(jobId, payload, userId);
  } catch (err) {
    await auditError("image.gen_failed", err, {
      jobId, projectId, userId, generationId,
      details: { sceneIndex },
    });
    throw err;
  }
}

async function _runCinematicImage(
  jobId: string,
  payload: CinematicImagePayload,
  userId?: string,
) {
  const { generationId, projectId, sceneIndex } = payload;

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "cinematic_image_started",
    message: `Cinematic image started for scene ${sceneIndex}`,
  });

  // Narrow SELECT — only the columns this handler reads.
  // SELECT * pulls the entire `scenes` jsonb (multi-MB on heavy projects)
  // which contended with concurrent atomic scene writes from sibling
  // handlers and statement-timed out under prod load (2026-05-17).
  // The cast unwraps Supabase's array-vs-singleton TS inference quirk —
  // PostgREST returns the embedded parent as a singleton object at runtime
  // regardless of how the auto-generated types model the relationship.
  type ProjectMeta = {
    format?: string | null;
    style?: string | null;
    character_description?: string | null;
    character_consistency_enabled?: boolean | null;
    project_type?: string | null;
    character_images?: string[] | null;
  };
  type GenerationRow = { scenes: unknown; projects: ProjectMeta | null };

  const { data: rawGeneration, error: genError } = await retryDbRead(() =>
    supabase
      .from("generations")
      .select("scenes, projects(format, style, character_description, character_consistency_enabled, project_type, character_images)")
      .eq("id", generationId)
      .maybeSingle()
  );

  // Distinguish "fetch failed" (transient — retried by withTransientRetry)
  // from "row truly missing" (terminal). Conflating them as
  // "Generation not found: <pg-error>" made statement timeouts look like
  // missing rows in the logs.
  if (genError) {
    throw new Error(`Generation fetch failed (${generationId}): ${genError.message}`);
  }
  if (!rawGeneration) {
    throw new Error(`Generation not found: ${generationId}`);
  }
  const generation = rawGeneration as unknown as GenerationRow;

  const scenes = generation.scenes as any[];
  const scene = scenes[sceneIndex];

  if (!scene) {
    throw new Error(`Scene ${sceneIndex} not found`);
  }

  const format = generation.projects?.format || "landscape";
  const style = generation.projects?.style || "realistic";
  const characterImages: string[] = generation.projects?.character_images || [];
  const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();

  if (!hyperealApiKey && !replicateApiKey) {
    throw new Error("Neither HYPEREAL_API_KEY nor REPLICATE_API_KEY is configured");
  }

  // Build the full image prompt with character bible, style, and format — same as other pipelines
  // Character bible is stored in scene _meta (set during script generation)
  const characterBible: Record<string, string> = scene._meta?.characterBible || scenes[0]?._meta?.characterBible || {};
  const characterDescription: string = generation.projects?.character_description || "";
  const rawVisual = scene.visualPrompt || scene.visual_prompt || "Cinematic scene";

  const prompt = buildImagePrompt(
    rawVisual,
    scene as ImageScene,
    0, // subIndex
    sceneIndex,
    {
      format,
      style,
      characterBible,
      characterDescription,
      isSmartFlow: generation.projects?.project_type === "smartflow",
    },
  );

  // Initialize per-scene progress (single scene for cinematic per-scene jobs)
  initSceneProgress(jobId, scenes.length, "cinematic_image");
  await updateSceneProgress(jobId, sceneIndex, "generating", {
    message: `Generating cinematic image for scene ${sceneIndex + 1}`,
  });

  const imageUrl = await generateImage(
    prompt, hyperealApiKey, replicateApiKey, format, projectId,
    characterImages.length > 0 ? characterImages : undefined,
    { userId: userId ?? null, generationId },
  );

  if (!imageUrl) {
    await updateSceneProgress(jobId, sceneIndex, "failed", {
      message: `Scene ${sceneIndex + 1} image generation failed`,
      error: "Image generation returned no URL",
    });
    clearSceneProgress(jobId);
    throw new Error("Image generation failed");
  }

  // Atomic update: only set this scene's imageUrl without overwriting other scenes
  await updateSceneField(generationId, sceneIndex, "imageUrl", imageUrl);

  // Opportunistic thumbnail: as soon as ANY scene image is ready, write
  // it to projects.thumbnail_url IF the project doesn't already have one.
  // The "WHERE thumbnail_url IS NULL" guard means scene 0's image wins
  // when it lands first, but a later scene's image still becomes the
  // thumbnail if scene 0 fails. Failed projects (audio fail, video fail
  // etc.) used to have no thumbnail because handleFinalize was the only
  // writer; now any project that gets at least one image rendered shows
  // up in the dashboard gallery with a real cover.
  await supabase
    .from("projects")
    .update({ thumbnail_url: imageUrl } as never)
    .eq("id", projectId)
    .is("thumbnail_url", null);

  await updateSceneProgress(jobId, sceneIndex, "complete", {
    message: `Scene ${sceneIndex + 1} cinematic image complete`,
  });
  clearSceneProgress(jobId);

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "cinematic_image_completed",
    message: `Cinematic image completed for scene ${sceneIndex}`,
  });

  await audit("image.gen_completed", {
    jobId, projectId, userId, generationId,
    message: `Cinematic image completed for scene ${sceneIndex}`,
    details: { sceneIndex },
  });

  return { success: true, status: "complete", sceneIndex, imageUrl };
}
