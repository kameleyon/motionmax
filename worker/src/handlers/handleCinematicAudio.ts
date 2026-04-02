/**
 * Cinematic audio handler — Qwen3 TTS via Replicate.
 *
 * For cinematic projects, uses Qwen3 TTS with:
 *   - custom_voice mode (preset speakers)
 *   - style_instruction per scene (AI-determined tone/emotion)
 *   - Multi-language support
 *
 * Exception: Haitian Creole falls back to existing Gemini TTS path
 * since Qwen3 doesn't support Creole.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateQwen3TTS } from "../services/qwen3TTS.js";
// Legacy router kept for Haitian Creole fallback
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { isHaitianCreole } from "../services/audioWavUtils.js";
import {
  initSceneProgress,
  updateSceneProgress,
  flushSceneProgress,
  clearSceneProgress,
} from "../lib/sceneProgress.js";

interface CinematicAudioPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  language?: string;
}

/** Infer a style_instruction from the voiceover text for Qwen3 TTS. */
function inferStyleInstruction(voiceover: string): string {
  const lower = voiceover.toLowerCase();

  // Detect emotional cues from content
  if (lower.includes("shocking") || lower.includes("unbelievable") || lower.includes("mind-blowing"))
    return "Speak with dramatic shock and disbelief, building intensity";
  if (lower.includes("secret") || lower.includes("hidden") || lower.includes("nobody knew"))
    return "Speak in a hushed, conspiratorial tone that draws the listener in";
  if (lower.includes("war") || lower.includes("battle") || lower.includes("fought"))
    return "Speak with gravity and intensity, like a war documentary narrator";
  if (lower.includes("love") || lower.includes("heart") || lower.includes("beautiful"))
    return "Speak with warmth and tenderness, gentle but compelling";
  if (lower.includes("death") || lower.includes("died") || lower.includes("tragedy"))
    return "Speak with somber reverence, slow and respectful";
  if (lower.includes("victory") || lower.includes("won") || lower.includes("triumph"))
    return "Speak with rising excitement and celebration";
  if (lower.includes("danger") || lower.includes("escape") || lower.includes("run"))
    return "Speak with urgency and breathless tension";
  if (lower.includes("laugh") || lower.includes("funny") || lower.includes("joke"))
    return "Speak with playful amusement and a hint of laughter";
  if (lower.includes("question") || lower.includes("what if") || lower.includes("why"))
    return "Speak with curiosity and intrigue, inviting the listener to think";

  // Default: energetic documentary narrator
  return "Speak with natural enthusiasm, varied pacing, and compelling storytelling energy";
}

export async function handleCinematicAudio(
  jobId: string,
  payload: CinematicAudioPayload,
  userId?: string
) {
  const { generationId, projectId, sceneIndex } = payload;

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_audio_started",
    message: `Cinematic audio started for scene ${sceneIndex}`,
  });

  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("*, projects(voice_type, voice_id, voice_name, presenter_focus, voice_inclination)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const scenes = generation.scenes as any[];
  const scene = scenes[sceneIndex];
  if (!scene) throw new Error(`Scene ${sceneIndex} not found`);

  const voiceover = scene.voiceover || "";

  // Language resolution
  const resolvedLanguage =
    payload.language ||
    generation.projects?.voice_inclination ||
    (Array.isArray(generation.scenes) && (generation.scenes as any[])[0]?._meta?.language) ||
    "en";

  // Haitian Creole detection — falls back to legacy router (Gemini TTS)
  const presenterFocus: string = generation.projects?.presenter_focus || "";
  const pfLower = presenterFocus.toLowerCase();
  const isHC = resolvedLanguage === "ht" ||
    pfLower.includes("haitian") || pfLower.includes("kreyòl") ||
    pfLower.includes("kreyol") || pfLower.includes("creole") ||
    isHaitianCreole(voiceover);

  // Initialize progress
  initSceneProgress(jobId, scenes.length, "cinematic_audio");
  await updateSceneProgress(jobId, sceneIndex, "generating", {
    message: `Generating cinematic audio for scene ${sceneIndex + 1}`,
  });

  let result: { url: string | null; durationSeconds?: number; provider?: string; error?: string };

  if (isHC) {
    // ── Haitian Creole: use legacy Gemini TTS path ──
    console.log(`[CinematicAudio] Scene ${sceneIndex}: Haitian Creole → legacy Gemini TTS`);
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
      voiceGender: generation.projects?.voice_name || "female",
      forceHaitianCreole: true,
      language: "ht",
    };

    if (generation.projects?.voice_type === "custom" && generation.projects?.voice_id) {
      config.customVoiceId = generation.projects.voice_id;
    }

    result = await generateSceneAudio(
      { number: sceneIndex + 1, voiceover, duration: scene.duration || 10 },
      config,
    );
  } else {
    // ── All other languages: Qwen3 TTS ──
    const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
    if (!replicateApiKey) throw new Error("REPLICATE_API_KEY not configured");

    // Get speaker from project voice_name or default
    const voiceName = generation.projects?.voice_name || "Nova";
    const styleInstruction = inferStyleInstruction(voiceover);

    console.log(`[CinematicAudio] Scene ${sceneIndex}: Qwen3 TTS speaker=${voiceName} lang=${resolvedLanguage} style="${styleInstruction.substring(0, 50)}"`);

    result = await generateQwen3TTS(
      {
        text: voiceover,
        sceneNumber: sceneIndex + 1,
        projectId,
        speaker: voiceName,
        language: resolvedLanguage,
        styleInstruction,
      },
      replicateApiKey,
    );
  }

  if (!result.url) {
    await updateSceneProgress(jobId, sceneIndex, "failed", {
      message: `Scene ${sceneIndex + 1} audio generation failed`,
      error: result.error,
    });
    clearSceneProgress(jobId);
    throw new Error(`Audio generation failed: ${result.error}`);
  }

  await updateSceneField(generationId, sceneIndex, "audioUrl", result.url);

  await updateSceneProgress(jobId, sceneIndex, "complete", {
    message: `Scene ${sceneIndex + 1} cinematic audio complete (${result.provider})`,
  });
  clearSceneProgress(jobId);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_audio_completed",
    message: `Cinematic audio completed for scene ${sceneIndex} (${result.provider})`,
  });

  return { success: true, status: "complete", sceneIndex, audioUrl: result.url };
}
