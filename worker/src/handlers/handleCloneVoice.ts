/**
 * Worker handler for the `clone_voice` job type.
 *
 * Flow:
 *   1. Edge function uploaded the user's recording to
 *      voice_samples/<userId>/<ts>-<name>.<ext>
 *   2. Edge function inserted a clone_voice job with
 *      payload: { storagePath, voiceName, description?, transcript?,
 *                 consentGiven, removeNoise }
 *   3. We download the sample, ffmpeg-transcode to MP3, POST to Fish
 *      /model with enhance_audio_quality=removeNoise (the user-facing
 *      "Remove background noise" toggle), and on success insert the
 *      new row into user_voices with provider='fish'.
 *
 * The browser polls the job by id and reads `result.voiceId` once
 * status flips to completed (same pattern as voice_preview).
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { cloneVoiceWithFish } from "../services/fishVoiceClone.js";

interface CloneVoicePayload {
  storagePath: string;
  voiceName: string;
  description?: string;
  /** Pulled into Fish's `texts` field — bumps clone fidelity when the
   *  user knows what they read. Optional. */
  transcript?: string;
  consentGiven: boolean;
  /** Maps to Fish's enhance_audio_quality flag (denoise + loudness
   *  normalisation). Defaults to true since Fish's enhancement is
   *  almost always strictly better than raw browser audio. */
  removeNoise?: boolean;
}

export interface CloneVoiceResult {
  voiceId: string;
  voiceName: string;
  rowId: string;
}

export async function handleCloneVoice(
  jobId: string,
  payload: CloneVoicePayload,
  userId: string,
): Promise<CloneVoiceResult> {
  const apiKey = (process.env.FISH_AUDIO_API_KEY || "").trim();
  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY not configured on the worker");

  if (!payload.consentGiven) {
    throw new Error("Consent is required to clone a voice");
  }
  if (!payload.storagePath || !payload.voiceName?.trim()) {
    throw new Error("storagePath and voiceName are required");
  }

  await writeSystemLog({
    jobId, userId,
    category: "system_info",
    eventType: "clone_voice_started",
    message: `Cloning voice "${payload.voiceName}" via Fish IVC`,
  });

  // Fish IVC call — transcode + multipart upload happens inside
  // cloneVoiceWithFish. ~5–10s for a 30s sample.
  const { voiceId } = await cloneVoiceWithFish(
    {
      storagePath: payload.storagePath,
      voiceName: payload.voiceName.trim(),
      description: payload.description,
      transcript: payload.transcript,
    },
    apiKey,
  );

  // Persist to user_voices. sample_url stays as the storage path so
  // the future backfill / re-clone has a stable reference; clients
  // that need a public URL build it from the path on read.
  const { data: row, error } = await supabase
    .from("user_voices")
    .insert({
      user_id: userId,
      voice_name: payload.voiceName.trim(),
      voice_id: voiceId,
      sample_url: payload.storagePath,
      description: payload.description ?? null,
      provider: "fish",
      original_sample_path: payload.storagePath,
    } as never)
    .select("id")
    .single();

  if (error || !row) {
    throw new Error(`Failed to persist user_voices row: ${error?.message ?? "no row"}`);
  }

  await writeSystemLog({
    jobId, userId,
    category: "system_info",
    eventType: "clone_voice_completed",
    message: `Voice "${payload.voiceName}" cloned (Fish id: ${voiceId})`,
  });

  return { voiceId, voiceName: payload.voiceName.trim(), rowId: (row as { id: string }).id };
}
