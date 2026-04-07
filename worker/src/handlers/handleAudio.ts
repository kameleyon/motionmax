/**
 * Audio phase handler for the Node.js worker.
 * Uses the SAME Qwen3 TTS + speaker mapping as cinematic audio.
 * Legacy router (LemonFox/FishAudio) only for Haitian Creole/French/Spanish
 * or when Qwen3 fails.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateQwen3TTS, SPEAKER_MAP } from "../services/qwen3TTS.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { isHaitianCreole } from "../services/audioWavUtils.js";
import {
  initSceneProgress,
  updateSceneProgress,
  flushSceneProgress,
  clearSceneProgress,
} from "../lib/sceneProgress.js";

// ── Types ──────────────────────────────────────────────────────────

interface AudioPayload {
  generationId: string;
  projectId: string;
  audioStartIndex?: number;
  [key: string]: unknown;
}

interface AudioResult {
  success: boolean;
  audioGenerated: number;
  hasMore: boolean;
  nextStartIndex?: number;
  audioSeconds: number;
  progress: number;
  phaseTime: number;
}

/** Infer a style_instruction from voiceover text for Qwen3 TTS (same as cinematic). */
function inferStyleInstruction(voiceover: string): string {
  const lower = voiceover.toLowerCase();

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

  return "Speak fast-paced with raw social media energy, punchy rapid-fire delivery, dramatic pauses for emphasis, hype moments that hit like a plot twist, enthusiast, energetic and mysterious, witty and fun, showing all kind of emotion matching the context";
}

// ── Legacy speakers that route to Fish Audio / LemonFox ──────────

const LEGACY_SPEAKER_MAP: Record<string, { gender: string; language: string }> = {
  "Jacques":  { gender: "male",   language: "fr" },
  "Camille":  { gender: "female", language: "fr" },
  "Carlos":   { gender: "male",   language: "es" },
  "Isabella": { gender: "female", language: "es" },
  "Adam":     { gender: "male",   language: "en" },
  "River":    { gender: "female", language: "en" },
};

// ── Handler ────────────────────────────────────────────────────────

export async function handleAudioPhase(
  jobId: string,
  payload: AudioPayload,
  userId?: string,
): Promise<AudioResult> {
  const phaseStart = Date.now();
  const { generationId, projectId } = payload;
  const startIndex = typeof payload.audioStartIndex === "number" ? payload.audioStartIndex : 0;

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "audio_phase_started",
    message: `Audio phase started at index ${startIndex}`,
  });

  // Fetch generation + project voice settings
  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("*, projects(voice_type, voice_id, voice_name, presenter_focus, voice_inclination)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const voiceName = generation.projects?.voice_name || "Nova";
  const voiceType = generation.projects?.voice_type || "standard";

  // Language resolution: payload → project voice_inclination → scenes[0]._meta.language
  const resolvedLanguage =
    (payload as any).language ||
    generation.projects?.voice_inclination ||
    (Array.isArray(generation.scenes) && (generation.scenes as any[])[0]?._meta?.language) ||
    "en";

  console.log(`[Audio] Language resolved: ${resolvedLanguage}`);

  // Haitian Creole detection
  const presenterFocus: string = generation.projects?.presenter_focus || "";
  const pfLower = presenterFocus.toLowerCase();
  const forceHaitianCreole =
    resolvedLanguage === "ht" ||
    pfLower.includes("haitian") || pfLower.includes("kreyòl") ||
    pfLower.includes("kreyol") || pfLower.includes("creole");

  const scenes = (generation.scenes || []) as any[];
  const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();

  let totalAudioSeconds = 0;
  let audioGenerated = 0;

  // Initialize per-scene progress tracking
  initSceneProgress(jobId, scenes.length, "audio_generation");
  for (let i = 0; i < scenes.length; i++) {
    if (scenes[i].audioUrl) {
      await updateSceneProgress(jobId, i, "complete", {
        message: `Scene ${i + 1} audio already generated`,
        flush: false,
      });
    }
  }
  await flushSceneProgress(jobId);

  // Process scenes in batches of 3
  const BATCH_SIZE = 3;

  for (let batchStart = startIndex; batchStart < scenes.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, scenes.length);
    console.log(`[Audio] Processing scenes ${batchStart + 1}-${batchEnd} of ${scenes.length}`);

    const batchPromises: Promise<void>[] = [];

    for (let i = batchStart; i < batchEnd; i++) {
      if (scenes[i].audioUrl) continue; // already done

      const voiceover = scenes[i].voiceover || "";
      if (!voiceover || voiceover.trim().length < 2) {
        console.warn(`[Audio] Scene ${i + 1}: No voiceover text, skipping`);
        continue;
      }

      await updateSceneProgress(jobId, i, "generating", {
        message: `Generating audio for scene ${i + 1}`,
        flush: false,
      });

      const sceneIndex = i;
      batchPromises.push((async () => {
        let result: { url: string | null; durationSeconds?: number; provider?: string; error?: string };

        // Haitian Creole or legacy speakers → legacy audio router
        const legacyMapping = LEGACY_SPEAKER_MAP[voiceName];
        const isHC = forceHaitianCreole || isHaitianCreole(voiceover);

        if (isHC) {
          // HC → legacy Gemini TTS path
          console.log(`[Audio] Scene ${sceneIndex + 1}: Haitian Creole → legacy router`);
          const googleApiKeys = [
            process.env.GOOGLE_TTS_API_KEY_3,
            process.env.GOOGLE_TTS_API_KEY_2,
            process.env.GOOGLE_TTS_API_KEY,
          ].filter(Boolean) as string[];

          const config: AudioConfig = {
            projectId, googleApiKeys,
            elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
            lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
            fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
            replicateApiKey,
            voiceGender: voiceName === "Pierre" ? "male" : voiceName === "Marie" ? "female" : "female",
            forceHaitianCreole: true,
            language: "ht",
          };
          if (voiceType === "custom" && generation.projects?.voice_id) {
            config.customVoiceId = generation.projects.voice_id;
          }
          result = await generateSceneAudio(
            { number: sceneIndex + 1, voiceover, duration: scenes[sceneIndex].duration || 8 },
            config,
          );
        } else if (legacyMapping) {
          // French/Spanish speakers → Fish Audio via legacy router
          console.log(`[Audio] Scene ${sceneIndex + 1}: ${voiceName} → legacy router (${legacyMapping.language}/${legacyMapping.gender})`);
          const googleApiKeys = [
            process.env.GOOGLE_TTS_API_KEY_3,
            process.env.GOOGLE_TTS_API_KEY_2,
            process.env.GOOGLE_TTS_API_KEY,
          ].filter(Boolean) as string[];

          const config: AudioConfig = {
            projectId, googleApiKeys,
            elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
            lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
            fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
            replicateApiKey,
            voiceGender: legacyMapping.gender,
            language: legacyMapping.language,
          };
          result = await generateSceneAudio(
            { number: sceneIndex + 1, voiceover, duration: scenes[sceneIndex].duration || 8 },
            config,
          );
        } else if (voiceType === "custom" && generation.projects?.voice_id) {
          // Custom cloned voice → ElevenLabs via legacy router
          console.log(`[Audio] Scene ${sceneIndex + 1}: Custom voice → legacy router`);
          const googleApiKeys = [
            process.env.GOOGLE_TTS_API_KEY_3,
            process.env.GOOGLE_TTS_API_KEY_2,
            process.env.GOOGLE_TTS_API_KEY,
          ].filter(Boolean) as string[];

          const config: AudioConfig = {
            projectId, googleApiKeys,
            elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
            lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
            fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
            replicateApiKey,
            customVoiceId: generation.projects.voice_id,
            voiceGender: "female",
            language: resolvedLanguage,
          };
          result = await generateSceneAudio(
            { number: sceneIndex + 1, voiceover, duration: scenes[sceneIndex].duration || 8 },
            config,
          );
        } else {
          // ── Qwen3 TTS with named speaker (same as cinematic) ──
          const styleInstruction = inferStyleInstruction(voiceover);
          console.log(`[Audio] Scene ${sceneIndex + 1}: Qwen3 TTS speaker=${voiceName} lang=${resolvedLanguage}`);

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

        if (result.url) {
          // Atomic update — no race condition with parallel image phase
          await updateSceneField(generationId, sceneIndex, "audioUrl", result.url);
          totalAudioSeconds += result.durationSeconds || 0;
          audioGenerated++;
          console.log(`✅ Scene ${sceneIndex + 1}: ${result.provider || "Qwen3"} (${(result.durationSeconds || 0).toFixed(1)}s)`);
          await updateSceneProgress(jobId, sceneIndex, "complete", {
            message: `Scene ${sceneIndex + 1} audio complete`,
            flush: false,
          });
        } else {
          console.warn(`[Audio] Scene ${sceneIndex + 1} failed: ${result.error}`);
          await updateSceneProgress(jobId, sceneIndex, "failed", {
            message: `Scene ${sceneIndex + 1} audio failed`,
            error: result.error,
            flush: false,
          });
        }
      })());
    }

    await Promise.all(batchPromises);
    await flushSceneProgress(jobId);
  }

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "audio_phase_completed",
    message: `Audio phase done: ${audioGenerated} scenes`,
    details: { audioGenerated, audioSeconds: totalAudioSeconds },
  });

  clearSceneProgress(jobId);

  return {
    success: true,
    audioGenerated,
    hasMore: false,
    audioSeconds: totalAudioSeconds,
    progress: 40,
    phaseTime: Date.now() - phaseStart,
  };
}
