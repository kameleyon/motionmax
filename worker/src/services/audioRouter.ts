/**
 * Routes a single scene to the correct TTS provider.
 * Mirrors generateSceneAudio() from supabase/functions/_shared/audioEngine.ts.
 *
 * Routing order:
 *   CASE 1 — HC + custom voice  → Gemini TTS → ElevenLabs STS
 *   CASE 2 — custom voice (non-HC) → ElevenLabs TTS
 *   CASE 3 — HC standard → Gemini TTS → ElevenLabs STS (preset voice)
 *   CASE 4 — default → Fish Audio (female) → Lemonfox → Chatterbox → Gemini fallback
 */

import { isHaitianCreole, sanitizeVoiceover } from "./audioWavUtils.js";
import {
  generateGeminiTTS,
  generateElevenLabsTTS,
  transformElevenLabsSTS,
  generateLemonfoxTTS,
  generateFishAudioTTS,
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

// HC STS preset voice IDs (from the edge function)
const HC_MALE_VOICE   = "WyscUDDs9ZWbMjTYd7By";
const HC_FEMALE_VOICE = "XZUXLIpE3dqJ9aCZUj2R";

// ── Router ─────────────────────────────────────────────────────────

export async function generateSceneAudio(
  scene: AudioScene,
  config: AudioConfig,
): Promise<AudioResult> {
  const voiceoverText = sanitizeVoiceover(scene.voiceover);
  if (!voiceoverText || voiceoverText.length < 2) {
    return { url: null, error: "No voiceover text" };
  }

  const {
    projectId,
    googleApiKeys,
    elevenLabsApiKey,
    lemonfoxApiKey,
    fishAudioApiKey,
    replicateApiKey,
    voiceGender = "female",
    customVoiceId,
    forceHaitianCreole = false,
  } = config;

  const isHC = forceHaitianCreole || isHaitianCreole(voiceoverText);

  // ── CASE 1: Haitian Creole + custom voice ─────────────────────────
  if (isHC && customVoiceId && elevenLabsApiKey && googleApiKeys.length > 0) {
    console.log(`[TTS] Scene ${scene.number}: HC + custom voice (Gemini → ElevenLabs STS)`);
    const gemini = await generateGeminiTTS(voiceoverText, scene.number, googleApiKeys, projectId);
    if (!gemini.url) return gemini;
    const sts = await transformElevenLabsSTS(gemini.url, customVoiceId, scene.number, elevenLabsApiKey, projectId);
    if (sts.url) console.log(`✅ Scene ${scene.number}: Gemini TTS → ElevenLabs STS (custom voice)`);
    return sts;
  }

  // ── CASE 2: Custom voice (non-HC) ────────────────────────────────
  if (customVoiceId && elevenLabsApiKey && !isHC) {
    console.log(`[TTS] Scene ${scene.number}: Custom voice via ElevenLabs TTS`);
    const result = await generateElevenLabsTTS(voiceoverText, scene.number, customVoiceId, elevenLabsApiKey, projectId);
    if (result.url) console.log(`✅ Scene ${scene.number}: ElevenLabs TTS (custom)`);
    return result;
  }

  // ── CASE 3: Haitian Creole standard voice ────────────────────────
  if (isHC && googleApiKeys.length > 0 && elevenLabsApiKey) {
    const stsVoiceId = voiceGender === "male" ? HC_MALE_VOICE : HC_FEMALE_VOICE;
    console.log(`[TTS] Scene ${scene.number}: HC standard → Gemini TTS → ElevenLabs STS (${voiceGender})`);
    const gemini = await generateGeminiTTS(voiceoverText, scene.number, googleApiKeys, projectId);
    if (!gemini.url) return { url: null, error: `HC TTS failed: ${gemini.error}` };
    const sts = await transformElevenLabsSTS(gemini.url, stsVoiceId, scene.number, elevenLabsApiKey, projectId);
    if (sts.url) {
      console.log(`✅ Scene ${scene.number}: Gemini → ElevenLabs STS HC (${voiceGender})`);
      return { ...sts, provider: `ElevenLabs STS HC (${voiceGender})` };
    }
    return sts;
  }

  // ── CASE 4: Default English/other ────────────────────────────────

  // Fish Audio (female primary)
  if (fishAudioApiKey && voiceGender === "female") {
    const fish = await generateFishAudioTTS(voiceoverText, scene.number, fishAudioApiKey, projectId);
    if (fish.url) { console.log(`✅ Scene ${scene.number}: Fish Audio`); return fish; }
    console.warn(`[TTS] Scene ${scene.number}: Fish Audio failed (${fish.error}), trying Lemonfox`);
  }

  // Lemonfox (male primary, female fallback)
  if (lemonfoxApiKey) {
    const lf = await generateLemonfoxTTS(voiceoverText, scene.number, voiceGender, lemonfoxApiKey, projectId);
    if (lf.url) { console.log(`✅ Scene ${scene.number}: Lemonfox`); return lf; }
    console.warn(`[TTS] Scene ${scene.number}: Lemonfox failed (${lf.error}), trying Chatterbox`);
  }

  // Chatterbox (Replicate)
  const cb = await generateChatterboxTTS(voiceoverText, scene.number, voiceGender, replicateApiKey, projectId);
  if (cb.url) { console.log(`✅ Scene ${scene.number}: Chatterbox`); return cb; }

  // Gemini TTS as last resort
  if (googleApiKeys.length > 0) {
    console.warn(`[TTS] Scene ${scene.number}: Chatterbox failed (${cb.error}), trying Gemini fallback`);
    const gemini = await generateGeminiTTS(voiceoverText, scene.number, googleApiKeys, projectId);
    if (gemini.url) { console.log(`✅ Scene ${scene.number}: Gemini TTS fallback`); return gemini; }
    return { url: null, error: `TTS exhausted all providers: ${cb.error}` };
  }

  return cb;
}
