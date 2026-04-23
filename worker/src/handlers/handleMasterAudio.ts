/**
 * Master audio handler — ONE continuous TTS call per generation for
 * doc2video + cinematic, replacing N per-scene `cinematic_audio` jobs.
 *
 * Why: per-scene audio generation burned Gemini quota and broke
 * narrative continuity (each scene was recorded cold). Now:
 *   1. Concatenate all scene voiceovers into one script
 *   2. Call Gemini Flash TTS ONCE (falls back to audio router on failure)
 *   3. ffprobe the result for true duration
 *   4. Write to generations.master_audio_url + master_audio_duration_ms
 *   5. Back-fill every scene's audioUrl with the master URL so existing
 *      editor + export code paths keep working without major changes
 *
 * Smartflow still uses per-scene `cinematic_audio` (it's always been
 * 1-scene anyway, so the two paths produce identical output there).
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { generateGeminiFlashTTS } from "../services/geminiFlashTTS.js";
import { generateSmallestTTS } from "../services/smallestTTS.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { isHaitianCreole } from "../services/audioWavUtils.js";
import { probeDuration } from "./export/ffmpegCmd.js";

interface MasterAudioPayload {
  generationId: string;
  projectId: string;
  language?: string;
}

/** Legacy-speaker → audio router config (Fish / LemonFox paths). */
const LEGACY_SPEAKER_MAP: Record<string, { gender: string; language: string }> = {
  "Jacques":  { gender: "male",   language: "fr" },
  "Camille":  { gender: "female", language: "fr" },
  "Carlos":   { gender: "male",   language: "es" },
  "Isabella": { gender: "female", language: "es" },
  "Adam":     { gender: "male",   language: "en" },
  "River":    { gender: "female", language: "en" },
};

function inferStyleInstruction(voiceover: string): string {
  const lower = voiceover.toLowerCase();
  if (lower.includes("shocking") || lower.includes("unbelievable"))
    return "Speak with dramatic shock and disbelief, building intensity";
  if (lower.includes("secret") || lower.includes("hidden"))
    return "Speak in a hushed, conspiratorial tone that draws the listener in";
  if (lower.includes("war") || lower.includes("battle"))
    return "Speak with gravity and intensity, like a war documentary narrator";
  if (lower.includes("love") || lower.includes("heart"))
    return "Speak with warmth and tenderness, gentle but compelling";
  if (lower.includes("death") || lower.includes("tragedy"))
    return "Speak with somber reverence, slow and respectful";
  if (lower.includes("victory") || lower.includes("triumph"))
    return "Speak with rising excitement and celebration";
  return "Speak fast-paced with raw social media energy, punchy rapid-fire delivery, dramatic pauses for emphasis, hype moments that hit like a plot twist, enthusiast, energetic and mysterious, witty and fun, showing all kind of emotion matching the context";
}

export async function handleMasterAudio(
  jobId: string,
  payload: MasterAudioPayload,
  userId?: string
): Promise<{ success: boolean; masterAudioUrl: string; masterAudioDurationMs: number; provider: string }> {
  const { generationId, projectId } = payload;

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "master_audio_started",
    message: `Master audio started (1 continuous TTS for all scenes)`,
  });

  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("*, projects(voice_type, voice_id, voice_name, presenter_focus, voice_inclination)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  const scenes = (generation.scenes as any[]) || [];
  if (scenes.length === 0) throw new Error(`No scenes to concatenate for master audio`);

  // Concatenate all scene voiceovers into one continuous script. The
  // LLM prompt (buildDoc2Video / buildCinematic) already instructs it
  // to write flowing narration across scenes — so joining produces a
  // cohesive track rather than disjoint fragments.
  const masterText = scenes
    .map((s: any) => typeof s.voiceover === "string" ? s.voiceover.trim() : "")
    .filter(Boolean)
    .join(" ");

  if (!masterText) throw new Error(`All scene voiceovers are empty`);

  // Language + voice resolution — identical logic to cinematic_audio.
  const resolvedLanguage =
    payload.language ||
    generation.projects?.voice_inclination ||
    scenes[0]?._meta?.language ||
    "en";

  const voiceName = generation.projects?.voice_name || "Nova";
  const presenterFocus: string = generation.projects?.presenter_focus || "";
  const pfLower = presenterFocus.toLowerCase();
  const isHC = resolvedLanguage === "ht" ||
    pfLower.includes("haitian") || pfLower.includes("kreyòl") ||
    pfLower.includes("kreyol") || pfLower.includes("creole") ||
    isHaitianCreole(masterText);

  let result: { url: string | null; durationSeconds?: number; provider?: string; error?: string } =
    { url: null };

  // ── Route to the right TTS provider by voice prefix ──
  if (isHC) {
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
      voiceGender: voiceName === "Pierre" ? "male" : "female",
      forceHaitianCreole: true,
      language: "ht",
    };
    result = await generateSceneAudio(
      { number: 1, voiceover: masterText, duration: Math.ceil(masterText.split(/\s+/).length / 2.5) },
      config,
    );
  } else if (voiceName.startsWith("gm:")) {
    // Gemini Flash — the most common path for doc2video + cinematic
    const googleApiKeys = [
      process.env.GOOGLE_TTS_API_KEY_3,
      process.env.GOOGLE_TTS_API_KEY_2,
      process.env.GOOGLE_TTS_API_KEY,
    ].filter(Boolean) as string[];
    result = await generateGeminiFlashTTS({
      text: masterText,
      sceneNumber: 0, // 0 = master, not a scene
      projectId,
      voiceName,
      language: resolvedLanguage,
      apiKeys: googleApiKeys,
      directives: {
        style: inferStyleInstruction(masterText),
        pacing: "energetic, varied — push forward in hook/action beats, soften into reflective moments",
      },
    });
  } else if (voiceName.startsWith("sm:") || voiceName.startsWith("sm2:")) {
    result = await generateSmallestTTS({
      text: masterText,
      sceneNumber: 0,
      projectId,
      voiceId: voiceName,
      language: resolvedLanguage,
    });
  } else {
    // Legacy named speakers (Adam, River, Jacques, Camille, Carlos, Isabella)
    // go through the standard audio router.
    const legacyMapping = LEGACY_SPEAKER_MAP[voiceName];
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
      voiceGender: legacyMapping?.gender || "female",
      language: legacyMapping?.language || resolvedLanguage,
    };
    result = await generateSceneAudio(
      { number: 1, voiceover: masterText, duration: Math.ceil(masterText.split(/\s+/).length / 2.5) },
      config,
    );
  }

  if (!result.url) {
    throw new Error(`Master audio generation failed: ${result.error ?? "unknown error"}`);
  }

  // Probe true duration — we need this to stretch visuals to fit.
  let durationMs = Math.round((result.durationSeconds ?? 0) * 1000);
  if (!durationMs) {
    try {
      const sec = await probeDuration(result.url);
      durationMs = Math.max(1000, Math.round(sec * 1000));
    } catch (err) {
      console.warn(`[MasterAudio] ffprobe failed, falling back to word-count estimate: ${(err as Error).message}`);
      durationMs = Math.ceil(masterText.split(/\s+/).length / 2.5) * 1000;
    }
  }

  // Persist master-audio fields + back-fill each scene's audioUrl with
  // the master URL so existing editor + export code works unchanged.
  // Also give each scene its proportional duration slice based on its
  // voiceover word count vs. total.
  const totalWords = masterText.split(/\s+/).length || 1;
  let cursorMs = 0;
  const updatedScenes = scenes.map((s: any) => {
    const words = typeof s.voiceover === "string"
      ? s.voiceover.trim().split(/\s+/).filter(Boolean).length
      : 0;
    const sliceMs = Math.max(500, Math.round((words / totalWords) * durationMs));
    const startMs = cursorMs;
    cursorMs += sliceMs;
    return {
      ...s,
      audioUrl: result.url,
      duration: Math.max(1, Math.round(sliceMs / 1000)),
      _meta: {
        ...(s._meta || {}),
        audioDurationMs: sliceMs,
        masterAudioSliceStartMs: startMs,
        masterAudioSliceEndMs: startMs + sliceMs,
      },
    };
  });

  await supabase
    .from("generations")
    .update({
      master_audio_url: result.url,
      master_audio_duration_ms: durationMs,
      scenes: updatedScenes,
    })
    .eq("id", generationId);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "master_audio_completed",
    message: `Master audio complete: ${result.provider ?? "unknown"}, ${(durationMs / 1000).toFixed(1)}s, ${scenes.length} scene slices`,
  });

  console.log(`[MasterAudio] ✅ ${(durationMs / 1000).toFixed(1)}s via ${result.provider}, sliced across ${scenes.length} scenes`);

  return {
    success: true,
    masterAudioUrl: result.url,
    masterAudioDurationMs: durationMs,
    provider: result.provider ?? "unknown",
  };
}
