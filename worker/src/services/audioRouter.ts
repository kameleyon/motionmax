/**
 * Routes a single scene to the TTS provider.
 * Uses Gemini TTS exclusively for all voice generation.
 */

import { sanitizeVoiceover } from "./audioWavUtils.js";
import { generateGeminiTTS } from "./audioProviders.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AudioScene {
  number: number;
  voiceover: string;
  duration: number;
}

export interface AudioConfig {
  projectId: string;
  googleApiKeys: string[];        // [KEY_3, KEY_2, KEY_1] or empty
  elevenLabsApiKey?: string;
  lemonfoxApiKey?: string;
  fishAudioApiKey?: string;
  replicateApiKey: string;
  voiceGender?: string;           // "male" | "female" (default "female")
  customVoiceId?: string;
  forceHaitianCreole?: boolean;
}

export interface AudioResult {
  url: string | null;
  durationSeconds?: number;
  provider?: string;
  error?: string;
}

// ── Router ─────────────────────────────────────────────────────────

export async function generateSceneAudio(
  scene: AudioScene,
  config: AudioConfig,
): Promise<AudioResult> {
  const voiceoverText = sanitizeVoiceover(scene.voiceover);
  if (!voiceoverText || voiceoverText.length < 2) {
    return { url: null, error: "No voiceover text" };
  }

  const { projectId, googleApiKeys } = config;

  if (googleApiKeys.length === 0) {
    return { url: null, error: "No Google TTS API keys configured" };
  }

  console.log(`[TTS] Scene ${scene.number}: Gemini TTS`);

  const result = await generateGeminiTTS(voiceoverText, scene.number, googleApiKeys, projectId);

  if (result.url) {
    console.log(`✅ Scene ${scene.number}: Gemini TTS`);
    return { ...result, provider: "Gemini TTS" };
  }

  return { url: null, error: `Gemini TTS failed: ${result.error}` };
}
