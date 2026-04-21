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
// Qwen3 TTS (Replicate) disabled — kept around in case we re-enable later.
// import { generateQwen3TTS } from "../services/qwen3TTS.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { generateSmallestTTS } from "../services/smallestTTS.js";
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

  // Default: viral social media energy
  return "Speak fast-paced with raw social media energy, punchy rapid-fire delivery, dramatic pauses for emphasis, hype moments that hit like a plot twist, enthusiast, energetic and mysterious, witty and fun, showing all kind of emotion matching the context";
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
      voiceGender: generation.projects?.voice_name === "Pierre" ? "male"
        : generation.projects?.voice_name === "Marie" ? "female"
        : generation.projects?.voice_name || "female",
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
    const voiceName = generation.projects?.voice_name || "Nova";

    // ── Smallest.ai Lightning v3.1 (ADDITIVE — testing phase) ──
    // Speaker IDs prefixed with `sm:` route to the new Smallest provider.
    // This does NOT interfere with the Fish Audio / LemonFox / Gemini
    // paths below — non-prefixed speakers continue to work exactly as
    // they did before.
    if (voiceName.startsWith("sm:")) {
      console.log(`[CinematicAudio] Scene ${sceneIndex}: ${voiceName} → Smallest TTS (lang=${resolvedLanguage})`);
      result = await generateSmallestTTS({
        text: voiceover,
        sceneNumber: sceneIndex + 1,
        projectId,
        voiceId: voiceName,
        language: resolvedLanguage,
      });

      if (!result.url) {
        await updateSceneProgress(jobId, sceneIndex, "failed", {
          message: `Scene ${sceneIndex + 1} Smallest audio generation failed`,
          error: result.error,
        });
        clearSceneProgress(jobId);
        throw new Error(`Audio generation failed: ${result.error}`);
      }

      await updateSceneField(generationId, sceneIndex, "audioUrl", result.url);

      const wordCount = (scene.voiceover || "").trim().split(/\s+/).length;
      const estimatedDuration = Math.max(3, Math.ceil(wordCount / 2.5));
      await updateSceneField(generationId, sceneIndex, "duration", String(estimatedDuration));

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

    // ── Fish Audio / LemonFox speakers → legacy audio router ──
    // These map specific speaker names to the standard TTS providers
    // Legacy speakers route to their original TTS providers (Fish Audio / LemonFox)
    const LEGACY_SPEAKER_MAP: Record<string, { gender: string; language: string }> = {
      "Jacques":  { gender: "male",   language: "fr" },
      "Camille":  { gender: "female", language: "fr" },
      "Carlos":   { gender: "male",   language: "es" },
      "Isabella": { gender: "female", language: "es" },
      "Adam":     { gender: "male",   language: "en" },
      "River":    { gender: "female", language: "en" },
    };

    const legacyMapping = LEGACY_SPEAKER_MAP[voiceName];

    if (legacyMapping) {
      // Route to Fish Audio / LemonFox via standard audio router
      console.log(`[CinematicAudio] Scene ${sceneIndex}: ${voiceName} → legacy router (${legacyMapping.language}/${legacyMapping.gender})`);

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
        voiceGender: legacyMapping.gender,
        language: legacyMapping.language,
      };

      result = await generateSceneAudio(
        { number: sceneIndex + 1, voiceover, duration: scene.duration || 10 },
        config,
      );
    } else {
      // ── Qwen3 TTS disabled (Replicate rate-limit issues) ──
      // Route ALL non-legacy speakers through the standard audio chain
      // (Gemini → Fish Audio → Lemonfox) instead of Qwen3 on Replicate.
      // Re-enable by uncommenting the generateQwen3TTS import and block above.
      console.log(`[CinematicAudio] Scene ${sceneIndex}: speaker=${voiceName} → standard chain (Qwen3 disabled) lang=${resolvedLanguage}`);

      const googleApiKeys = [
        process.env.GOOGLE_TTS_API_KEY_3,
        process.env.GOOGLE_TTS_API_KEY_2,
        process.env.GOOGLE_TTS_API_KEY,
      ].filter(Boolean) as string[];

      // Best-effort gender heuristic from the speaker display name so the
      // router picks a matching voice when Gemini/Fish/Lemonfox need one.
      const MALE_NAMES = new Set(["Atlas", "Kai", "Marcus", "Leo", "Sage", "Adam", "Jacques", "Carlos", "Pierre"]);
      const genderGuess = MALE_NAMES.has(voiceName) ? "male" : "female";

      const stdConfig: AudioConfig = {
        projectId,
        googleApiKeys,
        elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
        lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
        fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
        replicateApiKey: process.env.REPLICATE_API_KEY || "",
        voiceGender: genderGuess,
        language: resolvedLanguage,
      };

      result = await generateSceneAudio(
        { number: sceneIndex + 1, voiceover, duration: scene.duration || 10 },
        stdConfig,
      );
    }
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

  // Update duration with estimate based on word count (~2.5 words/sec)
  // This replaces the hardcoded "15" or "10" from the script with a realistic value.
  // The export step will probe the actual file for exact duration.
  const wordCount = (scene.voiceover || "").trim().split(/\s+/).length;
  const estimatedDuration = Math.max(3, Math.ceil(wordCount / 2.5));
  await updateSceneField(generationId, sceneIndex, "duration", String(estimatedDuration));

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
