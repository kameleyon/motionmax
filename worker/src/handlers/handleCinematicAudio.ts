import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { isHaitianCreole } from "../services/audioWavUtils.js";

interface CinematicAudioPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  language?: string;
}

export async function handleCinematicAudio(
  jobId: string,
  payload: CinematicAudioPayload,
  userId?: string
) {
  const { generationId, projectId, sceneIndex } = payload;

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "cinematic_audio_started",
    message: `Cinematic audio started for scene ${sceneIndex}`,
  });

  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("*, projects!inner(voice_type, voice_id, voice_name, presenter_focus)")
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

  const voiceType = generation.projects?.voice_type || "standard";
  const voiceGender = generation.projects?.voice_name || "female";

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
    voiceGender,
  };

  if (voiceType === "custom" && generation.projects?.voice_id) {
    config.customVoiceId = generation.projects.voice_id;
  }

  // Language from job payload (set by frontend cinematic pipeline)
  if (payload.language) {
    config.language = payload.language;
  }

  // Haitian Creole detection — matches edge function pattern
  const presenterFocus: string = generation.projects?.presenter_focus || "";
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

  const result = await generateSceneAudio(
    { number: sceneIndex + 1, voiceover: scene.voiceover || "", duration: scene.duration || 8 },
    config
  );

  if (!result.url) {
    throw new Error(`Audio generation failed: ${result.error}`);
  }

  // Atomic update: only set this scene's audioUrl without overwriting other scenes
  await updateSceneField(generationId, sceneIndex, "audioUrl", result.url);

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "cinematic_audio_completed",
    message: `Cinematic audio completed for scene ${sceneIndex}`,
  });

  return { success: true, status: "complete", sceneIndex, audioUrl: result.url };
}
