/**
 * Generate a short voice preview sample.
 * task_type: "voice_preview"
 *
 * Produces a 3-5 second audio clip for the selected speaker
 * so users can hear the voice before choosing.
 */

import { generateQwen3TTS } from "../services/qwen3TTS.js";
import { generateOpenAITTS } from "../services/audioProviders.js";
import { generateSceneAudio, type AudioConfig } from "../services/audioRouter.js";

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

  if (speaker.startsWith("C.")) {
    // OpenAI TTS via OpenRouter
    const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");
    result = await generateOpenAITTS(previewText, 0, speaker, apiKey, "voice-preview");
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
    // Qwen3 TTS
    const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
    if (!replicateApiKey) throw new Error("REPLICATE_API_KEY not configured");

    result = await generateQwen3TTS(
      {
        text: previewText,
        sceneNumber: 0,
        projectId: "voice-preview",
        speaker,
        language,
        styleInstruction: "Speak with warmth and natural enthusiasm, like introducing yourself to a friend",
      },
      replicateApiKey,
    );
  }

  if (!result.url) {
    throw new Error(`Voice preview failed: ${result.error}`);
  }

  console.log(`[VoicePreview] Preview ready: ${speaker} → ${result.url?.substring(0, 60)}`);

  return { success: true, audioUrl: result.url };
}
