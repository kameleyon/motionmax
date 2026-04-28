/**
 * Worker handler for the `rename_voice` job type.
 *
 * Renames a user's cloned voice on BOTH sides:
 *   1. Fish Audio — PATCH /model/{id} updates the title (so Fish's
 *      dashboard shows the new name when the operator logs in)
 *   2. user_voices — UPDATE voice_name so the MotionMax UI reflects
 *      the new label everywhere (Voice Lab, Inspector, intake picker)
 *
 * The two updates are NOT in a single transaction — Fish PATCH is
 * external. If the PATCH fails we surface the error and DO NOT update
 * the local row, so the user can retry without ending up with a
 * mismatched friendly name in MotionMax vs the Fish dashboard.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { renameFishVoice } from "../services/fishVoiceClone.js";

interface RenameVoicePayload {
  /** user_voices row id (NOT the Fish voice_id). */
  rowId: string;
  /** New friendly name to display in MotionMax + Fish dashboard. */
  newName: string;
  /** Optional new description. Pass null to leave unchanged; pass "" to clear. */
  newDescription?: string | null;
}

export interface RenameVoiceResult {
  rowId: string;
  voiceId: string;
  newName: string;
}

export async function handleRenameVoice(
  jobId: string,
  payload: RenameVoicePayload,
  userId: string,
): Promise<RenameVoiceResult> {
  const apiKey = (process.env.FISH_AUDIO_API_KEY || "").trim();
  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY not configured on the worker");

  const newName = payload.newName?.trim();
  if (!payload.rowId || !newName) {
    throw new Error("rowId and newName are required");
  }

  // Confirm the row belongs to the caller — RLS would block a
  // cross-user attempt, but the worker uses the service role so we
  // gate explicitly.
  const { data: existing, error: fetchErr } = await supabase
    .from("user_voices")
    .select("id, user_id, voice_id, voice_name, provider, description")
    .eq("id", payload.rowId)
    .maybeSingle();
  if (fetchErr || !existing) {
    throw new Error(`Voice row not found: ${fetchErr?.message ?? "no row"}`);
  }
  if ((existing as { user_id?: string }).user_id !== userId) {
    throw new Error("Voice row does not belong to caller");
  }

  const voiceId = (existing as { voice_id: string }).voice_id;
  const provider = (existing as { provider?: string }).provider ?? "fish";

  await writeSystemLog({
    jobId, userId,
    category: "system_info",
    eventType: "rename_voice_started",
    message: `Renaming voice ${voiceId.slice(0, 8)}… → "${newName}"`,
  });

  // Fish-side rename. ElevenLabs clones aren't supported here yet —
  // only Fish exposes a PATCH /model/{id} we can call. If we add
  // ElevenLabs rename later, branch on provider here.
  if (provider !== "fish") {
    throw new Error(`Rename not supported for provider "${provider}" yet`);
  }

  // Description: pass through verbatim. If undefined, leave Fish-side
  // description unchanged by NOT including it in the PATCH body.
  const fishDescription = payload.newDescription === undefined
    ? null
    : payload.newDescription;
  await renameFishVoice(voiceId, newName, fishDescription, apiKey);

  // Local update — only after Fish confirmed. Avoids the local row
  // diverging from Fish if Fish rejected the rename.
  const localUpdate: Record<string, string | null> = { voice_name: newName };
  if (payload.newDescription !== undefined) {
    localUpdate.description = payload.newDescription;
  }
  const { error: updateErr } = await supabase
    .from("user_voices")
    .update(localUpdate as never)
    .eq("id", payload.rowId);
  if (updateErr) {
    throw new Error(`Failed to update user_voices: ${updateErr.message}`);
  }

  await writeSystemLog({
    jobId, userId,
    category: "system_info",
    eventType: "rename_voice_completed",
    message: `Voice ${voiceId.slice(0, 8)}… renamed to "${newName}"`,
  });

  return { rowId: payload.rowId, voiceId, newName };
}
