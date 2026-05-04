/**
 * Cinematic video EDIT handler — text-prompt edit of an existing
 * scene clip via Hypereal `grok-imagine-video-edit`.
 *
 * Replaces the previous flow where a single image edit forced two
 * full image-to-video re-renders (the affected scene + the previous
 * scene's end-frame transition). Editing the existing video with
 * Grok Imagine is faster, cheaper, and preserves the rest of the
 * frame instead of re-imagining it from scratch.
 *
 * Task type: cinematic_video_edit
 * Payload  : { generationId, projectId, sceneIndex, sourceVideoUrl,
 *              editPrompt, regenerate? }
 * Returns  : { videoUrl }
 *
 * The previous video is snapshotted into scene._history so the
 * Inspector's Undo path keeps working unchanged.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { editVideoWithGrokImagine } from "../services/hypereal.js";
import { retryDbRead } from "../lib/retryClassifier.js";

interface CinematicVideoEditPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  /** URL of the existing scene video to edit. The caller — usually
   *  the auto-chain in handleRegenerateImage — looks this up from
   *  generations.scenes[sceneIndex].videoUrl BEFORE clearing the
   *  field, then forwards it here so the worker can hit it
   *  directly without racing the scene update. */
  sourceVideoUrl: string;
  /** Text instruction describing the visual change to apply. For
   *  the auto-chain path this is the user's `imageModification`
   *  string — the same instruction they typed in the editor's
   *  "Edit image" textbox. */
  editPrompt: string;
  /** Flag the call as a regeneration so a history snapshot of the
   *  PRIOR videoUrl gets persisted into scene._history. Mirrors
   *  the same field on the cinematic_video task. */
  regenerate?: boolean;
}

export async function handleCinematicVideoEdit(
  jobId: string,
  payload: CinematicVideoEditPayload,
  userId?: string,
): Promise<{ videoUrl: string }> {
  const { generationId, projectId, sceneIndex, sourceVideoUrl, editPrompt, regenerate } = payload;

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_video_edit_started",
    message: `Cinematic video edit started for scene ${sceneIndex}`,
    details: { sceneIndex, sourceVideoUrl: sourceVideoUrl?.substring(0, 80), editPromptLen: editPrompt?.length ?? 0 },
  });

  // Defensive validation — surface bad payloads with a clear error so
  // upstream queue diagnostics aren't a "Hypereal 400" mystery.
  if (!sourceVideoUrl || typeof sourceVideoUrl !== "string") {
    throw new Error("cinematic_video_edit: payload.sourceVideoUrl is required");
  }
  if (!editPrompt || typeof editPrompt !== "string" || editPrompt.trim().length === 0) {
    throw new Error("cinematic_video_edit: payload.editPrompt is required");
  }

  // Pull the scenes array up front so we can snapshot the prior
  // videoUrl into scene._history if this is a regen. We don't need
  // the project row here — grok-imagine-video-edit is a pure
  // video-in / video-out transform, no aspect / style metadata.
  const { data: generation, error: genError } = await retryDbRead(() =>
    supabase
      .from("generations")
      .select("scenes")
      .eq("id", generationId)
      .maybeSingle()
  );
  if (genError || !generation) {
    throw new Error(`cinematic_video_edit: generation not found: ${genError?.message ?? "no row"}`);
  }
  const scenes = generation.scenes as any[];
  const scene = scenes[sceneIndex];
  if (!scene) {
    throw new Error(`cinematic_video_edit: scene ${sceneIndex} not found in generation`);
  }

  // History snapshot for Undo. Mirrors handleCinematicVideo's pattern
  // (5-deep ring buffer in scene._history). On a fresh edit we record
  // the videoUrl that's about to be replaced.
  if (regenerate) {
    const history = Array.isArray(scene._history) ? [...scene._history] : [];
    history.push({ timestamp: new Date().toISOString(), videoUrl: scene.videoUrl });
    if (history.length > 5) history.shift();
    scenes[sceneIndex]._history = history;
    await supabase.from("generations").update({ scenes }).eq("id", generationId);
  }

  const apiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  if (!apiKey) throw new Error("HYPEREAL_API_KEY not configured");

  console.log(
    `[CinematicVideoEdit] Scene ${sceneIndex}: grok-imagine-video-edit, ` +
    `prompt=${editPrompt.length} chars, source=${sourceVideoUrl.substring(0, 80)}`,
  );

  const editedVideoUrl = await editVideoWithGrokImagine(sourceVideoUrl, editPrompt, apiKey);

  await updateSceneField(generationId, sceneIndex, "videoUrl", editedVideoUrl);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_video_edit_completed",
    message: `Cinematic video edit completed for scene ${sceneIndex}`,
    details: { sceneIndex, videoUrl: editedVideoUrl?.substring(0, 80) },
  });

  return { videoUrl: editedVideoUrl };
}
