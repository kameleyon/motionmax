/**
 * Atomic scene field update helper.
 * Uses the `update_scene_field` RPC to avoid read-modify-write race conditions
 * when multiple concurrent worker jobs update different scenes in the same generation.
 */
import { supabase } from "./supabase.js";

/**
 * Atomically update a single text field on a specific scene in the generations table.
 * Uses Postgres jsonb_set under the hood — no full-array overwrite.
 */
export async function updateSceneField(
  generationId: string,
  sceneIndex: number,
  field: string,
  value: string
): Promise<void> {
  const { error } = await (supabase as any).rpc("update_scene_field", {
    p_generation_id: generationId,
    p_scene_index: sceneIndex,
    p_field: field,
    p_value: value,
  });

  if (error) {
    console.error(
      `[SceneUpdate] RPC update_scene_field failed for gen=${generationId} scene=${sceneIndex} field=${field}:`,
      error.message
    );
    // Fallback: read-modify-write (better than losing the URL entirely)
    await fallbackUpdateSceneField(generationId, sceneIndex, field, value);
  }
}

/**
 * Fallback for environments where the RPC is not yet deployed.
 * Reads the full array, modifies one element, writes back.
 */
async function fallbackUpdateSceneField(
  generationId: string,
  sceneIndex: number,
  field: string,
  value: string
): Promise<void> {
  const { data: gen, error: readError } = await supabase
    .from("generations")
    .select("scenes")
    .eq("id", generationId)
    .single();

  if (readError || !gen) {
    throw new Error(`Fallback read failed: ${readError?.message}`);
  }

  const scenes = gen.scenes as any[];
  if (!scenes[sceneIndex]) {
    throw new Error(`Scene ${sceneIndex} not found in fallback update`);
  }

  scenes[sceneIndex][field] = value;

  const { error: writeError } = await supabase
    .from("generations")
    .update({ scenes })
    .eq("id", generationId);

  if (writeError) {
    throw new Error(`Fallback write failed: ${writeError.message}`);
  }

  console.warn(`[SceneUpdate] Used fallback read-modify-write for gen=${generationId} scene=${sceneIndex} field=${field}`);
}
