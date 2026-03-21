/**
 * Regenerate audio for a specific scene via the worker queue.
 * task_type: "regenerate_audio"
 *
 * Uses the same audio routing logic as the batch audio phase,
 * but targets a single scene with a new voiceover text.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { isHaitianCreole } from "../services/audioWavUtils.js";

// ── Types ──────────────────────────────────────────────────────────

interface RegenerateAudioPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  newVoiceover: string;
  [key: string]: unknown;
}

interface RegenerateAudioResult {
  success: boolean;
  sceneIndex: number;
  audioUrl: string | null;
  duration: number;
  voiceover: string;
  _history: unknown[];
}

// ── Handler ────────────────────────────────────────────────────────

export async function handleRegenerateAudio(
  jobId: string,
  payload: RegenerateAudioPayload,
  userId?: string,
): Promise<RegenerateAudioResult> {
  const { generationId, projectId, sceneIndex, newVoiceover } = payload;

  if (!newVoiceover?.trim()) throw new Error("newVoiceover is required");

  const googleApiKeys = [
    process.env.GOOGLE_TTS_API_KEY_3,
    process.env.GOOGLE_TTS_API_KEY_2,
    process.env.GOOGLE_TTS_API_KEY,
  ].filter(Boolean) as string[];

  const config: AudioConfig = {
    projectId,
    googleApiKeys,
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
    lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
    fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
    replicateApiKey: process.env.REPLICATE_API_KEY || "",
  };

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "regenerate_audio_started",
    message: `Regenerating audio for scene ${sceneIndex + 1}`,
  });

  // Fetch generation + project voice settings (including presenter_focus for Creole detection)
  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("scenes, projects!inner(voice_type, voice_id, voice_name, presenter_focus)")
    .eq("id", generationId)
    .single();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const voiceType: string = (generation.projects as any)?.voice_type || "standard";
  const voiceGender: string = (generation.projects as any)?.voice_name || "female";
  const voiceId: string | undefined =
    voiceType === "custom" ? (generation.projects as any)?.voice_id : undefined;

  if (voiceId) config.customVoiceId = voiceId;
  if (voiceGender) config.voiceGender = voiceGender;

  // Haitian Creole detection → Google TTS (3 API keys)
  const presenterFocus: string = (generation.projects as any)?.presenter_focus || "";
  if (presenterFocus && isHaitianCreole(presenterFocus)) {
    config.forceHaitianCreole = true;
  }

  const scenes: any[] = generation.scenes || [];
  if (sceneIndex < 0 || sceneIndex >= scenes.length) throw new Error("Invalid scene index");

  const scene = scenes[sceneIndex];

  const audioResult = await generateSceneAudio(
    {
      number: scene.number || sceneIndex + 1,
      voiceover: newVoiceover,
      duration: scene.duration || 15,
    },
    config,
  );

  const duration = Math.ceil(audioResult.durationSeconds || scene.duration || 15);

  // Snapshot history for undo
  const history = Array.isArray(scene._history) ? [...scene._history] : [];
  history.push({
    timestamp: new Date().toISOString(),
    audioUrl: scene.audioUrl,
    voiceover: scene.voiceover,
    duration: scene.duration,
  });
  if (history.length > 5) history.shift();

  // Patch scene in DB
  scenes[sceneIndex] = {
    ...scene,
    voiceover: newVoiceover,
    audioUrl: audioResult.url,
    duration,
    _history: history,
  };

  await supabase.from("generations").update({ scenes }).eq("id", generationId);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "regenerate_audio_completed",
    message: `Scene ${sceneIndex + 1} audio regenerated (${duration}s, provider: ${audioResult.provider || "unknown"})`,
  });

  console.log(`[RegenerateAudio] Scene ${sceneIndex + 1} done: ${audioResult.url?.substring(0, 80)}`);

  return {
    success: true,
    sceneIndex,
    audioUrl: audioResult.url,
    duration,
    voiceover: newVoiceover,
    _history: scenes[sceneIndex]._history || [],
  };
}
