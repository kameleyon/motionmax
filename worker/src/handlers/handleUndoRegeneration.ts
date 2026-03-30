import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";

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
  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("scenes")
    .eq("id", generationId)
    .single();

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
    .order("version_number", { ascending: false })
    .limit(1);

  if (versionsError) {
    throw new Error(`Failed to fetch version history: ${versionsError.message}`);
  }

  if (!versions || versions.length === 0) {
    throw new Error("Nothing to undo - no version history found");
  }

  const previousVersion = versions[0];

  // Restore previous state
  scenes[sceneIndex] = {
    ...scene,
    voiceover: previousVersion.voiceover || scene.voiceover,
    visualPrompt: previousVersion.visual_prompt || scene.visualPrompt,
    imageUrl: previousVersion.image_url || scene.imageUrl,
    imageUrls: previousVersion.image_urls ? JSON.parse(previousVersion.image_urls as any) : scene.imageUrls,
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