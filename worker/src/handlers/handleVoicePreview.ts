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

  // ── Smallest.ai preview (ADDITIVE — testing) ──
  // `sm:*`-prefixed speakers use Smallest Lightning v3.1. Legacy speakers
  // continue through the Fish Audio / LemonFox / Gemini path below.
  if (speaker.startsWith("sm:")) {
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
