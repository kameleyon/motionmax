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

  const history = scene._history || [];

  if (history.length === 0) {
    throw new Error("Nothing to undo");
  }

  const previous = history.pop();

  // Restore previous state
  scenes[sceneIndex] = {
    ...scene,
    ...previous,
    _history: history,
    timestamp: undefined, // remove timestamp from restored fields
  };

  await supabase
    .from("generations")
    .update({ scenes })
    .eq("id", generationId);

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "undo_regeneration_completed",
    message: `Undo regeneration completed for scene ${sceneIndex}`,
  });

  return { success: true, scene: scenes[sceneIndex], historyRemaining: history.length };
}