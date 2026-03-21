/**
 * TTS provider router — exact routing rules:
 *
 * ═══════════ ENGLISH ═══════════
 * Male (standard)   → LemonFox        → Fallback: Chatterbox (Replicate)
 * Female (standard) → Fish Audio      → Fallback: Chatterbox (Replicate)
 * Clone (any)       → ElevenLabs TTS  → NO fallback
 *
 * ═══════════ HAITIAN CREOLE ═══════════
 * Standard (m/f)    → Google TTS (3 API keys) → NO fallback
 * Clone             → Google TTS (3 API keys) → ElevenLabs STS → NO fallback
 *
 * Same logic for generation AND regeneration.
 */

import { sanitizeVoiceover, isHaitianCreole } from "./audioWavUtils.js";
import {
  generateLemonfoxTTS,
  generateFishAudioTTS,
  generateGeminiTTS,
  generateElevenLabsTTS,
  transformElevenLabsSTS,
  generateChatterboxTTS,
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
  voiceGender?: string;           // "male" | "female"
  customVoiceId?: string;         // set when voice_type === "custom"
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
  const text = sanitizeVoiceover(scene.voiceover);
  if (!text || text.length < 2) {
    return { url: null, error: "No voiceover text" };
  }

  const { projectId, googleApiKeys } = config;
  const gender = (config.voiceGender || "female").toLowerCase();
  const isClone = !!config.customVoiceId;

  // Detect Haitian Creole from config flag OR from the voiceover text itself
  const isCreole = config.forceHaitianCreole || isHaitianCreole(text);
  if (isCreole && !config.forceHaitianCreole) {
    console.log(`[TTS] Scene ${scene.number}: Auto-detected Haitian Creole from voiceover text`);
  }

  // ════════════════════════════════════════════════════════════════
  //  HAITIAN CREOLE
  // ════════════════════════════════════════════════════════════════

  if (isCreole) {
    // Creole + Clone → Google TTS → ElevenLabs STS (no fallback)
    if (isClone && config.elevenLabsApiKey) {
      console.log(`[TTS] Scene ${scene.number}: Creole+Clone → Gemini → ElevenLabs STS`);
      const baseResult = await generateGeminiTTS(text, scene.number, googleApiKeys, projectId);
      if (!baseResult.url) {
        return { url: null, error: `Creole base audio failed: ${baseResult.error}` };
      }
      const stsResult = await transformElevenLabsSTS(
        baseResult.url, config.customVoiceId!, scene.number, config.elevenLabsApiKey, projectId,
      );
      if (stsResult.url) {
        console.log(`✅ Scene ${scene.number}: Creole+Clone (Gemini → STS)`);
        return { ...stsResult, provider: "Gemini → ElevenLabs STS (Creole clone)" };
      }
      return { url: null, error: `Creole STS failed: ${stsResult.error}` };
    }

    // Creole standard (male or female) → Google TTS only (no fallback)
    console.log(`[TTS] Scene ${scene.number}: Creole → Google TTS (${gender})`);
    const result = await generateGeminiTTS(text, scene.number, googleApiKeys, projectId);
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Google TTS (Creole, ${gender})`);
      return { ...result, provider: `Google TTS (Creole, ${gender})` };
    }
    return { url: null, error: `Creole Google TTS failed: ${result.error}` };
  }

  // ════════════════════════════════════════════════════════════════
  //  ENGLISH
  // ════════════════════════════════════════════════════════════════

  // English + Clone → ElevenLabs TTS (no fallback)
  if (isClone && config.elevenLabsApiKey) {
    console.log(`[TTS] Scene ${scene.number}: English+Clone → ElevenLabs TTS`);
    const result = await generateElevenLabsTTS(
      text, scene.number, config.customVoiceId!, config.elevenLabsApiKey, projectId,
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: ElevenLabs TTS (clone)`);
      return result;
    }
    return { url: null, error: `ElevenLabs clone TTS failed: ${result.error}` };
  }

  // English Male → LemonFox → Fallback: Chatterbox (Replicate)
  if (gender === "male") {
    if (config.lemonfoxApiKey) {
      console.log(`[TTS] Scene ${scene.number}: English Male → LemonFox`);
      const result = await generateLemonfoxTTS(text, scene.number, "male", config.lemonfoxApiKey, projectId);
      if (result.url) {
        console.log(`✅ Scene ${scene.number}: LemonFox (male)`);
        return result;
      }
      console.warn(`[TTS] Scene ${scene.number}: LemonFox failed, Chatterbox fallback`);
    }
    // Fallback: Chatterbox via Replicate
    if (config.replicateApiKey) {
      const fb = await generateChatterboxTTS(text, scene.number, "male", config.replicateApiKey, projectId);
      if (fb.url) {
        console.log(`✅ Scene ${scene.number}: Chatterbox fallback (male)`);
        return fb;
      }
    }
    return { url: null, error: "English male: LemonFox + Chatterbox both failed" };
  }

  // English Female → Fish Audio → Fallback: Chatterbox (Replicate)
  if (config.fishAudioApiKey) {
    console.log(`[TTS] Scene ${scene.number}: English Female → Fish Audio`);
    const result = await generateFishAudioTTS(text, scene.number, config.fishAudioApiKey, projectId);
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish Audio (female)`);
      return result;
    }
    console.warn(`[TTS] Scene ${scene.number}: Fish Audio failed, Chatterbox fallback`);
  }
  // Fallback: Chatterbox via Replicate
  if (config.replicateApiKey) {
    const fb = await generateChatterboxTTS(text, scene.number, "female", config.replicateApiKey, projectId);
    if (fb.url) {
      console.log(`✅ Scene ${scene.number}: Chatterbox fallback (female)`);
      return fb;
    }
  }
  return { url: null, error: "English female: Fish Audio + Chatterbox both failed" };
}
