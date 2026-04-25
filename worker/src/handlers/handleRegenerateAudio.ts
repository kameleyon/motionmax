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
// Qwen3 TTS (Replicate) disabled — standard audio chain handles all speakers.
// import { generateQwen3TTS } from "../services/qwen3TTS.js";
import { generateSmallestTTS } from "../services/smallestTTS.js";
import { generateGeminiFlashTTS } from "../services/geminiFlashTTS.js";
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
  // Gemini Flash voices — gender per Google's internal bias. Logged
  // only (Gemini path routes by voiceName, not gender), but the log
  // used to say "female" for every gm:* voice because of the fall-
  // back default on an unrecognised name. Matches the new labels
  // surfaced in SpeakerSelector.tsx.
  "gm:Leda":         { gender: "female", language: "en" },
  "gm:Aoede":        { gender: "female", language: "en" },
  "gm:Callirrhoe":   { gender: "female", language: "en" },
  "gm:Sulafat":      { gender: "female", language: "en" },
  "gm:Vindemiatrix": { gender: "female", language: "en" },
  "gm:Achernar":     { gender: "female", language: "en" },
  "gm:Laomedeia":    { gender: "female", language: "en" },
  "gm:Kore":         { gender: "female", language: "en" },
  "gm:Charon":       { gender: "male",   language: "en" },
  "gm:Orus":         { gender: "male",   language: "en" },
  "gm:Iapetus":      { gender: "male",   language: "en" },
  "gm:Rasalgethi":   { gender: "male",   language: "en" },
  "gm:Algenib":      { gender: "male",   language: "en" },
  "gm:Fenrir":       { gender: "male",   language: "en" },
  "gm:Puck":         { gender: "male",   language: "en" },
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
  return "Speak Natural human pace matching the topic and emotion requires, conversational tone with natural pauses and human expression, match the energy of the topic, while remaining clear and very human";
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

  // ── UNIFIED VOICE ROUTING — works for ALL project types ──
  const legacyMapping = LEGACY_SPEAKER_MAP[voiceName];
  const presenterFocus: string = project?.presenter_focus || "";
  const isHC = resolvedLanguage === "ht" ||
    isHaitianCreole(newVoiceover) ||
    presenterFocus.toLowerCase().includes("creole") ||
    presenterFocus.toLowerCase().includes("haitian");

  // Resolve gender & language from the speaker name (Jacques→male/fr) or fall back to defaults
  const gender = legacyMapping?.gender || (voiceName === "male" ? "male" : voiceName === "female" ? "female" : "female");
  const lang = legacyMapping?.language || (isHC ? "ht" : resolvedLanguage);

  console.log(`[RegenerateAudio] Resolved voice → speaker=${voiceName}, gender=${gender}, language=${lang}, isHC=${isHC}`);

  // ── Gemini 3.1 Flash TTS (gm:*) — FR/ES/IT/DE/NL with style directives ──
  // No fallback — if the API fails the scene fails and we surface the error.
  if (voiceName.startsWith("gm:") && !isHC) {
    console.log(`[RegenerateAudio] Gemini Flash TTS speaker=${voiceName} lang=${resolvedLanguage}`);
    const styleInstruction = inferStyleInstruction(newVoiceover);
    audioResult = await generateGeminiFlashTTS({
      text: newVoiceover,
      sceneNumber: sceneIndex + 1,
      projectId,
      voiceName,
      language: resolvedLanguage,
      apiKeys: [
        process.env.GOOGLE_TTS_API_KEY_3,
        process.env.GOOGLE_TTS_API_KEY_2,
        process.env.GOOGLE_TTS_API_KEY,
      ].filter(Boolean) as string[],
      directives: {
        style: styleInstruction,
        pacing: "natural human conversational tone pace, varied — push forward in hook/action beats, soften into reflective moments",
      },
    });
  } else if ((voiceName.startsWith("sm:") || voiceName.startsWith("sm2:")) && !isHC) {
    // ── Smallest.ai (ADDITIVE — testing) ──
    // `sm:*` + `sm2:*` prefixes route to Smallest. v2 voices removed from
    // the UI but kept addressable so legacy projects don't blow up.
    console.log(`[RegenerateAudio] Smallest TTS speaker=${voiceName} lang=${resolvedLanguage}`);
    audioResult = await generateSmallestTTS({
      text: newVoiceover,
      sceneNumber: sceneIndex + 1,
      projectId,
      voiceId: voiceName,
      language: resolvedLanguage,
    });
  } else

  // Qwen3 TTS disabled — every speaker now routes through the standard audio
  // chain (Gemini → Fish Audio → Lemonfox). Re-enable by restoring the
  // `if (projectType === "cinematic" && !legacyMapping && !isHC)` block.
  {
    // Standard audio router — handles all named speakers, all languages, all project types
    const voiceType = project?.voice_type || "standard";
    const voiceId = voiceType === "custom" ? project?.voice_id : undefined;

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

    if (voiceId) {
      config.customVoiceId = voiceId;
      const { resolveCustomVoiceProvider } = await import("../services/customVoiceProvider.js");
      config.customVoiceProvider = await resolveCustomVoiceProvider(voiceId);
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
