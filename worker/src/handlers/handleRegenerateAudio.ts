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
  language?: string;
  [key: string]: unknown;
}

interface RegenerateAudioResult {
  success: boolean;
  sceneIndex: number;
  audioUrl: string | null;
  duration: number;
  voiceover: string;
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

  // Fetch generation + project voice settings (including presenter_focus, voice_inclination for language)
  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("scenes, projects(voice_type, voice_id, voice_name, presenter_focus, voice_inclination)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const voiceType: string = (generation.projects as any)?.voice_type || "standard";
  const voiceGender: string = (generation.projects as any)?.voice_name || "female";
  const voiceId: string | undefined =
    voiceType === "custom" ? (generation.projects as any)?.voice_id : undefined;

  if (voiceId) config.customVoiceId = voiceId;
  if (voiceGender) config.voiceGender = voiceGender;

  // Language resolution: payload → project voice_inclination → scenes[0]._meta.language
  const resolvedLanguage =
    payload.language ||
    (generation.projects as any)?.voice_inclination ||
    (Array.isArray(generation.scenes) && (generation.scenes as any[])[0]?._meta?.language) ||
    undefined;
  if (resolvedLanguage) {
    config.language = resolvedLanguage;
    console.log(`[RegenerateAudio] Language resolved: ${resolvedLanguage}`);
  }

  // Haitian Creole detection — matches edge function pattern
  const presenterFocus: string = (generation.projects as any)?.presenter_focus || "";
  const pfLower = presenterFocus.toLowerCase();
  const forceCreoleFromPresenter =
    pfLower.includes("haitian") ||
    pfLower.includes("kreyòl") ||
    pfLower.includes("kreyol") ||
    pfLower.includes("creole") ||
    isHaitianCreole(presenterFocus);
  if (forceCreoleFromPresenter) {
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

  // Save current state as a version in scene_versions table
  await supabase.rpc("save_scene_version", {
    p_generation_id: generationId,
    p_scene_index: sceneIndex,
    p_voiceover: scene.voiceover || null,
    p_visual_prompt: scene.visualPrompt || null,
    p_image_url: scene.imageUrl || null,
    p_image_urls: scene.imageUrls ? JSON.stringify(scene.imageUrls) : null,
    p_audio_url: scene.audioUrl || null,
    p_duration: scene.duration || null,
    p_video_url: scene.videoUrl || null,
    p_change_type: "audio",
  });

  // Patch scene in DB
  scenes[sceneIndex] = {
    ...scene,
    voiceover: newVoiceover,
    audioUrl: audioResult.url,
    duration,
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
  };
}
