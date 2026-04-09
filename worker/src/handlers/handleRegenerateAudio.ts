/**
 * Regenerate audio for a specific scene via the worker queue.
 * task_type: "regenerate_audio"
 *
 * For CINEMATIC projects: routes through the same Qwen3/Fish Audio/LemonFox/Gemini
 * logic as handleCinematicAudio, preserving the user's chosen speaker.
 *
 * For other projects: uses the standard audio router with project voice settings.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { generateQwen3TTS } from "../services/qwen3TTS.js";
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

/** Map cinematic speaker names to legacy router gender+language */
const LEGACY_SPEAKER_MAP: Record<string, { gender: string; language: string }> = {
  "Jacques":  { gender: "male",   language: "fr" },
  "Camille":  { gender: "female", language: "fr" },
  "Carlos":   { gender: "male",   language: "es" },
  "Isabella": { gender: "female", language: "es" },
  "Adam":     { gender: "male",   language: "en" },
  "River":    { gender: "female", language: "en" },
  "Pierre":   { gender: "male",   language: "ht" },
  "Marie":    { gender: "female", language: "ht" },
};

/** Infer style instruction from voiceover (same as handleCinematicAudio) */
function inferStyleInstruction(voiceover: string): string {
  const lower = voiceover.toLowerCase();
  if (lower.includes("shocking") || lower.includes("unbelievable")) return "Speak with dramatic shock and disbelief, building intensity";
  if (lower.includes("secret") || lower.includes("hidden")) return "Speak in a hushed, conspiratorial tone that draws the listener in";
  if (lower.includes("war") || lower.includes("battle")) return "Speak with gravity and intensity, like a war documentary narrator";
  if (lower.includes("love") || lower.includes("heart")) return "Speak with warmth and tenderness, gentle but compelling";
  if (lower.includes("death") || lower.includes("died")) return "Speak with somber reverence, slow and respectful";
  if (lower.includes("victory") || lower.includes("won")) return "Speak with rising excitement and celebration";
  if (lower.includes("danger") || lower.includes("escape")) return "Speak with urgency and breathless tension";
  if (lower.includes("laugh") || lower.includes("funny")) return "Speak with playful amusement and a hint of laughter";
  if (lower.includes("question") || lower.includes("what if")) return "Speak with curiosity and intrigue, inviting the listener to think";
  return "Speak with raw social media energy, punchy pacing, dramatic pauses for emphasis, hype moments that hit like a plot twist, enthusiast, energetic and mysterious, witty and fun, showing all kind of emotion matching the context";
}

// ── Handler ────────────────────────────────────────────────────────

export async function handleRegenerateAudio(
  jobId: string,
  payload: RegenerateAudioPayload,
  userId?: string,
): Promise<RegenerateAudioResult> {
  const { generationId, projectId, sceneIndex, newVoiceover } = payload;

  if (!newVoiceover?.trim()) throw new Error("newVoiceover is required");

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "regenerate_audio_started",
    message: `Regenerating audio for scene ${sceneIndex + 1}`,
  });

  // Fetch generation + project settings
  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("scenes, projects(voice_type, voice_id, voice_name, presenter_focus, voice_inclination, project_type)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const project = generation.projects as any;
  const projectType = project?.project_type || "doc2video";
  const voiceName = project?.voice_name || "female";
  const scenes: any[] = generation.scenes || [];
  if (sceneIndex < 0 || sceneIndex >= scenes.length) throw new Error("Invalid scene index");
  const scene = scenes[sceneIndex];

  // Language resolution — project's voice_inclination stores the language chosen at creation
  const resolvedLanguage =
    payload.language ||
    project?.voice_inclination ||
    (Array.isArray(generation.scenes) && (generation.scenes as any[])[0]?._meta?.language) ||
    "en";

  console.log(`[RegenerateAudio] Project voice settings → speaker=${voiceName}, language=${resolvedLanguage}, type=${projectType}, voice_inclination=${project?.voice_inclination || "none"}`);

  let audioResult: { url: string | null; durationSeconds?: number; provider?: string; error?: string };

  // ── CINEMATIC: use same routing as handleCinematicAudio ──
  if (projectType === "cinematic") {
    const isHC = resolvedLanguage === "ht" ||
      isHaitianCreole(newVoiceover) ||
      (project?.presenter_focus || "").toLowerCase().includes("creole");

    const legacyMapping = LEGACY_SPEAKER_MAP[voiceName];

    if (isHC || legacyMapping) {
      // Route to Fish Audio / LemonFox / Gemini via legacy router
      const gender = legacyMapping?.gender ||
        (voiceName === "Pierre" ? "male" : voiceName === "Marie" ? "female" : "female");
      const lang = legacyMapping?.language || (isHC ? "ht" : resolvedLanguage);

      console.log(`[RegenerateAudio] Cinematic ${voiceName} → legacy router (${lang}/${gender})`);

      const config: AudioConfig = {
        projectId,
        googleApiKeys: [
          process.env.GOOGLE_TTS_API_KEY_3,
          process.env.GOOGLE_TTS_API_KEY_2,
          process.env.GOOGLE_TTS_API_KEY,
        ].filter(Boolean) as string[],
        elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
        lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
        fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
        replicateApiKey: process.env.REPLICATE_API_KEY || "",
        voiceGender: gender,
        language: lang,
        forceHaitianCreole: isHC,
      };

      audioResult = await generateSceneAudio(
        { number: scene.number || sceneIndex + 1, voiceover: newVoiceover, duration: scene.duration || 10 },
        config,
      );
    } else {
      // Qwen3 TTS
      const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
      if (!replicateApiKey) throw new Error("REPLICATE_API_KEY not configured");

      const styleInstruction = inferStyleInstruction(newVoiceover);
      console.log(`[RegenerateAudio] Cinematic Qwen3 speaker=${voiceName} lang=${resolvedLanguage}`);

      audioResult = await generateQwen3TTS(
        {
          text: newVoiceover,
          sceneNumber: sceneIndex + 1,
          projectId,
          speaker: voiceName,
          language: resolvedLanguage,
          styleInstruction,
        },
        replicateApiKey,
      );
    }
  } else {
    // ── NON-CINEMATIC: standard audio router ──
    const config: AudioConfig = {
      projectId,
      googleApiKeys: [
        process.env.GOOGLE_TTS_API_KEY_3,
        process.env.GOOGLE_TTS_API_KEY_2,
        process.env.GOOGLE_TTS_API_KEY,
      ].filter(Boolean) as string[],
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
      lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
      fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
      replicateApiKey: process.env.REPLICATE_API_KEY || "",
    };

    const voiceType = project?.voice_type || "standard";
    const voiceId = voiceType === "custom" ? project?.voice_id : undefined;

    if (voiceId) config.customVoiceId = voiceId;
    // For standard non-cinematic, voice_name is "male"/"female"
    config.voiceGender = voiceName === "male" ? "male" : "female";

    if (resolvedLanguage) config.language = resolvedLanguage;

    // Haitian Creole detection
    const presenterFocus: string = project?.presenter_focus || "";
    if (
      presenterFocus.toLowerCase().includes("haitian") ||
      presenterFocus.toLowerCase().includes("creole") ||
      isHaitianCreole(newVoiceover)
    ) {
      config.forceHaitianCreole = true;
    }

    audioResult = await generateSceneAudio(
      { number: scene.number || sceneIndex + 1, voiceover: newVoiceover, duration: scene.duration || 10 },
      config,
    );
  }

  if (!audioResult.url) throw new Error(`Audio regen failed: ${audioResult.error}`);

  const duration = Math.ceil(audioResult.durationSeconds || scene.duration || 10);

  // Save version history
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
  scenes[sceneIndex] = { ...scene, voiceover: newVoiceover, audioUrl: audioResult.url, duration };
  await supabase.from("generations").update({ scenes }).eq("id", generationId);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "regenerate_audio_completed",
    message: `Scene ${sceneIndex + 1} audio regenerated (${duration}s, ${audioResult.provider || "unknown"}, speaker: ${voiceName})`,
  });

  console.log(`[RegenerateAudio] Scene ${sceneIndex + 1} done: ${audioResult.provider} speaker=${voiceName}`);

  return { success: true, sceneIndex, audioUrl: audioResult.url, duration, voiceover: newVoiceover };
}
