import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { audit, auditError } from "../lib/audit.js";
import { retryDbRead } from "../lib/retryClassifier.js";

interface UndoRegenerationPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
}

export async function handleUndoRegeneration(
  jobId: string,
  payload: UndoRegenerationPayload,
  userId?: string
) {
  const { generationId, projectId, sceneIndex } = payload;

  await audit("image.gen_started", {
    jobId, projectId, userId, generationId,
    message: `Undo regeneration started for scene ${sceneIndex}`,
    details: { sceneIndex, mode: "undo" },
  });

  try {
    return await _runUndoRegeneration(jobId, payload, userId);
  } catch (err) {
    await auditError("image.gen_failed", err, {
      jobId, projectId, userId, generationId,
      details: { sceneIndex, mode: "undo" },
    });
    throw err;
  }
}

async function _runUndoRegeneration(
  jobId: string,
  payload: UndoRegenerationPayload,
  userId?: string,
) {
  const { generationId, projectId, sceneIndex } = payload;

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "undo_regeneration_started",
    message: `Undo regeneration started for scene ${sceneIndex}`,
  });

  // Fetch current generation scenes
  const { data: generation, error: genError } = await retryDbRead(() =>
    supabase
      .from("generations")
      .select("scenes")
      .eq("id", generationId)
      .single()
  );

  if (genError || !generation) {
    throw new Error(`Generation not found: ${genError?.message}`);
  }

  const scenes = generation.scenes as any[];
  const scene = scenes[sceneIndex];

  if (!scene) {
    throw new Error(`Scene ${sceneIndex} not found`);
  }

  // Get the most recent version from scene_versions table
  const { data: versions, error: versionsError } = await supabase
    .from("scene_versions")
    .select("*")
    .eq("generation_id", generationId)
    .eq("scene_index", sceneIndex)
    .order("created_at", { ascending: false })
    .limit(1);

  if (versionsError) {
    throw new Error(`Failed to fetch version history: ${versionsError.message}`);
  }

  if (!versions || versions.length === 0) {
    throw new Error("Nothing to undo - no version history found");
  }

  const previousVersion = versions[0];

  // Defensive image_urls parse — legacy rows may be a JSON-stringified
  // array, an already-parsed array (jsonb column), or a bare URL
  // string from very old rows. JSON.parse on a bare URL throws
  // "Unexpected token 'h'" (the user hit this on Restore).
  const parseImageUrls = (raw: unknown): string[] | null => {
    if (raw == null) return null;
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw !== 'string') return null;
    const t = raw.trim();
    if (!t) return null;
    if (t.startsWith('[') || t.startsWith('{')) {
      try { return JSON.parse(t) as string[]; } catch { return [t]; }
    }
    return [t];
  };

  // Restore previous state
  scenes[sceneIndex] = {
    ...scene,
    voiceover: previousVersion.voiceover || scene.voiceover,
    visualPrompt: previousVersion.visual_prompt || scene.visualPrompt,
    imageUrl: previousVersion.image_url || scene.imageUrl,
    imageUrls: parseImageUrls(previousVersion.image_urls) ?? scene.imageUrls,
    audioUrl: previousVersion.audio_url || scene.audioUrl,
    duration: previousVersion.duration || scene.duration,
    videoUrl: previousVersion.video_url || null, // Clear video if restoring old image/audio
  };

  // Update the generation
  await supabase
    .from("generations")
    .update({ scenes })
    .eq("id", generationId);

  // Delete the version we just restored (it becomes the current state)
  await supabase
    .from("scene_versions")
    .delete()
    .eq("id", previousVersion.id);

  // Count remaining versions
  const { count: remainingCount } = await supabase
    .from("scene_versions")
    .select("id", { count: "exact", head: true })
    .eq("generation_id", generationId)
    .eq("scene_index", sceneIndex);

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "undo_regeneration_completed",
    message: `Undo regeneration completed for scene ${sceneIndex} (${remainingCount || 0} versions remaining)`,
  });

  return { success: true, scene: scenes[sceneIndex], historyRemaining: remainingCount || 0 };
}