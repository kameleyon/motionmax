/**
 * Generate a short voice preview sample.
 * task_type: "voice_preview"
 *
 * Produces a 3-5 second audio clip for the selected speaker
 * so users can hear the voice before choosing.
 */

// Qwen3 TTS (Replicate) disabled — previews route through standard chain.
// import { generateQwen3TTS } from "../services/qwen3TTS.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";
import { generateSmallestTTS } from "../services/smallestTTS.js";
import { generateGeminiFlashTTS } from "../services/geminiFlashTTS.js";
import { supabase } from "../lib/supabase.js";

interface VoicePreviewPayload {
  speaker: string;
  language: string;
  text: string;
}

/** Map speakers to legacy router (Fish Audio / LemonFox / Gemini) */
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

export async function handleVoicePreview(
  jobId: string,
  payload: VoicePreviewPayload,
  userId?: string,
) {
  const { speaker, language, text } = payload;
  const previewText = text || `Hello, I'm ${speaker}. This is how my voice sounds.`;

  console.log(`[VoicePreview] Generating preview for speaker=${speaker} lang=${language}`);

  const legacyMapping = LEGACY_SPEAKER_MAP[speaker];

  let result: { url: string | null; error?: string };

  // ── Cloned-voice preview (clone:<external_id>) ──
  // Resolves the user's clone row, then routes through the audio engine
  // with customVoiceId + customVoiceProvider so Fish s2-pro / ElevenLabs
  // pick it up as a custom voice. Without this branch, clone:* speakers
  // fell into the generic else-block and the playground couldn't preview
  // user-cloned voices at all.
  if (speaker.startsWith("clone:")) {
    const externalId = speaker.slice("clone:".length);
    if (!userId) {
      throw new Error("Voice preview: clone playback requires sign-in");
    }
    const { data: clone, error } = await supabase
      .from("user_voices")
      .select("voice_id, voice_name, provider")
      .eq("user_id", userId)
      .eq("voice_id", externalId)
      .maybeSingle();
    if (error || !clone) {
      throw new Error(`Voice preview: clone ${externalId} not found in your library`);
    }
    const provider = (clone as { provider?: string }).provider === "elevenlabs" ? "elevenlabs" : "fish";
    const config: AudioConfig = {
      projectId: "voice-preview",
      googleApiKeys: [
        process.env.GOOGLE_TTS_API_KEY_3,
        process.env.GOOGLE_TTS_API_KEY_2,
        process.env.GOOGLE_TTS_API_KEY,
      ].filter(Boolean) as string[],
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
      lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
      fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
      replicateApiKey: process.env.REPLICATE_API_KEY || "",
      voiceGender: "neutral",
      language,
      customVoiceId: externalId,
      customVoiceProvider: provider,
    };
    result = await generateSceneAudio(
      { number: 0, voiceover: previewText, duration: 5 },
      config,
    );
  } else
  // ── Gemini 3.1 Flash TTS preview (gm:*) ──
  // Preview uses the exact style directives the user asked for so the
  // voice sample showcases what the full narration will sound like with
  // steering. This also doubles as a demo of the model's steerability.
  if (speaker.startsWith("gm:")) {
    // IMPORTANT: do NOT pass English-language style directives for the
    // preview. Gemini TTS prepends directive text into the input; an
    // English "Southern California valley girl" directive in front of
    // a French sample produced the mixed FR/EN garbling users were
    // hearing ("Bonjour, merci for choosing my voice..."). For
    // previews we want a clean, language-native read. Steering stays
    // applied during the FULL generation path where the directives are
    // authored per-scene and in the target language.
    result = await generateGeminiFlashTTS({
      text: previewText,
      sceneNumber: 0,
      projectId: "voice-preview",
      voiceName: speaker,
      language,
      apiKeys: [
        process.env.GOOGLE_TTS_API_KEY_3,
        process.env.GOOGLE_TTS_API_KEY_2,
        process.env.GOOGLE_TTS_API_KEY,
      ].filter(Boolean) as string[],
      // No directives → clean native-language preview.
    });
  } else
  // ── Smallest.ai preview (ADDITIVE — testing) ──
  // `sm:*`-prefixed speakers use Smallest Lightning v3.1. Legacy speakers
  // continue through the Fish Audio / LemonFox / Gemini path below.
  if (speaker.startsWith("sm:") || speaker.startsWith("sm2:")) {
    result = await generateSmallestTTS({
      text: previewText,
      sceneNumber: 0,
      projectId: "voice-preview",
      voiceId: speaker,
      language,
    });
  } else if (legacyMapping) {
    // Fish Audio / LemonFox / Gemini
    const config: AudioConfig = {
      projectId: "voice-preview",
      googleApiKeys: [
        process.env.GOOGLE_TTS_API_KEY_3,
        process.env.GOOGLE_TTS_API_KEY_2,
        process.env.GOOGLE_TTS_API_KEY,
      ].filter(Boolean) as string[],
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
      lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
      fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
      replicateApiKey: process.env.REPLICATE_API_KEY || "",
      voiceGender: legacyMapping.gender,
      language: legacyMapping.language,
      forceHaitianCreole: legacyMapping.language === "ht",
    };

    result = await generateSceneAudio(
      { number: 0, voiceover: previewText, duration: 5 },
      config,
    );
  } else {
    // Qwen3 TTS disabled — route non-legacy speakers through the standard chain
    // with a gender heuristic from the display name.
    const MALE_NAMES = new Set(["Atlas", "Kai", "Marcus", "Leo", "Sage"]);
    const genderGuess = MALE_NAMES.has(speaker) ? "male" : "female";

    const config: AudioConfig = {
      projectId: "voice-preview",
      googleApiKeys: [
        process.env.GOOGLE_TTS_API_KEY_3,
        process.env.GOOGLE_TTS_API_KEY_2,
        process.env.GOOGLE_TTS_API_KEY,
      ].filter(Boolean) as string[],
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY,
      lemonfoxApiKey: process.env.LEMONFOX_API_KEY,
      fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
      replicateApiKey: process.env.REPLICATE_API_KEY || "",
      voiceGender: genderGuess,
      language,
    };

    result = await generateSceneAudio(
      { number: 0, voiceover: previewText, duration: 5 },
      config,
    );
  }

  if (!result.url) {
    throw new Error(`Voice preview failed: ${result.error}`);
  }

  console.log(`[VoicePreview] Preview ready: ${speaker} → ${result.url?.substring(0, 60)}`);

  return { success: true, audioUrl: result.url };
}
