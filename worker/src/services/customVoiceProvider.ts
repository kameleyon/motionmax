/**
 * Resolve which TTS provider hosts a given cloned voice.
 *
 * The projects table stores voice_id as the EXTERNAL id (Fish model
 * id or ElevenLabs voice id). To know which API to call at TTS time
 * the worker has to look up the matching user_voices row and read its
 * `provider` column.
 *
 * Falls back to "elevenlabs" if the row isn't found — the original
 * behaviour, preserves back-compat with rows that pre-date the
 * provider column being added.
 */

import { supabase } from "../lib/supabase.js";

export async function resolveCustomVoiceProvider(
  voiceId: string,
): Promise<"fish" | "elevenlabs"> {
  if (!voiceId) return "elevenlabs";
  const { data, error } = await supabase
    .from("user_voices")
    .select("provider")
    .eq("voice_id", voiceId)
    .maybeSingle();
  if (error || !data) return "elevenlabs";
  const p = (data as { provider?: string }).provider;
  return p === "fish" ? "fish" : "elevenlabs";
}
