/**
 * Routes a single scene to the correct TTS provider based on:
 *
 *   Male English        → LemonFox
 *   Female English      → Fish Audio
 *   Haitian Creole      → Gemini TTS  (3 API key rotation)
 *   Cloned voice        → Gemini TTS → ElevenLabs STS
 *   Fallback (all)      → Gemini TTS  (3 API key rotation)
 */

import { sanitizeVoiceover } from "./audioWavUtils.js";
import {
  generateLemonfoxTTS,
  generateFishAudioTTS,
  generateGeminiTTS,
  transformElevenLabsSTS,
} from "./audioProviders.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AudioScene {
  number: number;
  voiceover: string;
  duration: number;
}

export interface AudioConfig {
  projectId: string;
  googleApiKeys: string[];
  elevenLabsApiKey?: string;
  lemonfoxApiKey?: string;
  fishAudioApiKey?: string;
  replicateApiKey: string;
  voiceGender?: string;           // "male" | "female" (default "female")
  customVoiceId?: string;         // set when voice_type === "custom"
  forceHaitianCreole?: boolean;
}

export interface AudioResult {
  url: string | null;
  durationSeconds?: number;
  provider?: string;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

async function tryGeminiFallback(
  text: string,
  scene: AudioScene,
  config: AudioConfig,
): Promise<AudioResult> {
  if (config.googleApiKeys.length === 0) {
    return { url: null, error: "No Gemini TTS API keys for fallback" };
  }
  console.log(`[TTS] Scene ${scene.number}: Falling back to Gemini TTS`);
  const result = await generateGeminiTTS(text, scene.number, config.googleApiKeys, config.projectId);
  if (result.url) {
    console.log(`✅ Scene ${scene.number}: Gemini TTS (fallback)`);
    return { ...result, provider: `Gemini TTS (fallback)` };
  }
  return { url: null, error: `Gemini fallback failed: ${result.error}` };
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
  const gender = (config.voiceGender || "female").toLowerCase();

  // ── 1. Haitian Creole → Gemini TTS, always male voice ───────────
  if (config.forceHaitianCreole) {
    if (googleApiKeys.length === 0) {
      return { url: null, error: "No Google TTS API keys for Haitian Creole" };
    }
    console.log(`[TTS] Scene ${scene.number}: Haitian Creole → Gemini TTS (male voice)`);
    const result = await generateGeminiTTS(voiceoverText, scene.number, googleApiKeys, projectId);
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Gemini TTS (Haitian Creole, male)`);
      return { ...result, provider: "Gemini TTS (Haitian Creole, male)" };
    }
    return { url: null, error: `Haitian Creole Gemini failed: ${result.error}` };
  }

  // ── 2. Cloned voice → Gemini TTS base + ElevenLabs STS ──────────
  if (config.customVoiceId && config.elevenLabsApiKey) {
    console.log(`[TTS] Scene ${scene.number}: Cloned voice → Gemini → ElevenLabs STS`);

    // Generate base audio with Gemini
    if (googleApiKeys.length === 0) {
      return { url: null, error: "No Google API keys for base audio (cloned voice)" };
    }
    const baseResult = await generateGeminiTTS(voiceoverText, scene.number, googleApiKeys, projectId);
    if (!baseResult.url) {
      return { url: null, error: `Base audio for STS failed: ${baseResult.error}` };
    }

    // Transform through ElevenLabs STS with cloned voice
    const stsResult = await transformElevenLabsSTS(
      baseResult.url,
      config.customVoiceId,
      scene.number,
      config.elevenLabsApiKey,
      projectId,
    );

    if (stsResult.url) {
      console.log(`✅ Scene ${scene.number}: ElevenLabs STS (cloned voice)`);
      return { ...stsResult, provider: "ElevenLabs STS (cloned)" };
    }

    // STS failed — use the base Gemini audio as fallback
    console.warn(`[TTS] Scene ${scene.number}: STS failed, using Gemini base`);
    return { ...baseResult, provider: "Gemini TTS (STS fallback)" };
  }

  // ── 3. Male English → LemonFox ──────────────────────────────────
  if (gender === "male" && config.lemonfoxApiKey) {
    console.log(`[TTS] Scene ${scene.number}: Male → LemonFox`);
    const result = await generateLemonfoxTTS(
      voiceoverText, scene.number, "male", config.lemonfoxApiKey, projectId,
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: LemonFox (male)`);
      return result;
    }
    console.warn(`[TTS] Scene ${scene.number}: LemonFox failed, trying Gemini fallback`);
    return tryGeminiFallback(voiceoverText, scene, config);
  }

  // ── 4. Female English → Fish Audio ──────────────────────────────
  if (gender === "female" && config.fishAudioApiKey) {
    console.log(`[TTS] Scene ${scene.number}: Female → Fish Audio`);
    const result = await generateFishAudioTTS(
      voiceoverText, scene.number, config.fishAudioApiKey, projectId,
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish Audio (female)`);
      return result;
    }
    console.warn(`[TTS] Scene ${scene.number}: Fish Audio failed, trying Gemini fallback`);
    return tryGeminiFallback(voiceoverText, scene, config);
  }

  // ── 5. Fallback → Gemini TTS ───────────────────────────────────
  return tryGeminiFallback(voiceoverText, scene, config);
}
