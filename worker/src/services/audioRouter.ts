/**
 * TTS provider router — mirrors edge function audioEngine.ts with modifications:
 *
 * CASE 1: HC + Clone        → Gemini TTS → ElevenLabs STS (clone voice)
 * CASE 2: Non-HC/FR + Clone → ElevenLabs TTS (no fallback)
 * CASE 3: HC Standard       → Gemini TTS ONLY (no STS, no fallback)
 * CASE 3b: French Male      → Fish Audio (model 1c86c56391ab4fefb7d376c86c0cf605)
 * CASE 3c: French Female    → Fish Audio (voice 42fe8376b029438e81dd2929c0889ce1)
 * CASE 4: English Male      → LemonFox → Chatterbox (Replicate)
 * CASE 5: English Female    → Fish Audio → Chatterbox (Replicate)
 *
 * Creole detected from: config.forceHaitianCreole OR isHaitianCreole(text)
 * French detected from: config.language === "fr" OR isFrench(text) auto-detection
 */

import { sanitizeVoiceover, isHaitianCreole, isFrench } from "./audioWavUtils.js";
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
  forceHaitianCreole?: boolean;   // from presenter_focus
  language?: string;              // "en" | "fr" | "ht" — explicit language selection
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

  // Detect Haitian Creole from config flag OR from voiceover text
  const isHC = forceHaitianCreole || config.language === "ht" || isHaitianCreole(voiceoverText);
  // Detect French from config OR from voiceover text (auto-detection for legacy projects)
  const isFR = config.language === "fr" || (!isHC && isFrench(voiceoverText));

  if (forceHaitianCreole && !isHaitianCreole(voiceoverText)) {
    console.log(`[TTS] Scene ${scene.number}: Forcing Haitian Creole from presenter_focus`);
  }
  if (!forceHaitianCreole && isHC) {
    console.log(`[TTS] Scene ${scene.number}: Auto-detected Haitian Creole from voiceover text`);
  }
  if (isFR && config.language !== "fr") {
    console.log(`[TTS] Scene ${scene.number}: Auto-detected French from voiceover text`);
  }

  // ========== CASE 1: Haitian Creole + Cloned Voice ==========
  // Gemini TTS → ElevenLabs Speech-to-Speech (clone voice)
  if (isHC && customVoiceId && elevenLabsApiKey && googleApiKeys.length > 0) {
    console.log(`[TTS] Scene ${scene.number}: HC + Clone → Gemini TTS → ElevenLabs STS`);

    const geminiResult = await generateGeminiTTS(voiceoverText, scene.number, googleApiKeys, projectId);
    if (!geminiResult.url) {
      return { url: null, error: `HC clone base audio failed: ${geminiResult.error}` };
    }

    const stsResult = await transformElevenLabsSTS(
      geminiResult.url, customVoiceId, scene.number, elevenLabsApiKey, projectId,
    );
    if (stsResult.url) {
      console.log(`✅ Scene ${scene.number}: Gemini TTS → ElevenLabs STS (HC clone)`);
      return { ...stsResult, provider: "Gemini → ElevenLabs STS (HC clone)" };
    }
    return { url: null, error: `HC clone STS failed: ${stsResult.error}` };
  }

  // ========== CASE 2: English + Cloned Voice ==========
  // ElevenLabs TTS directly (no fallback)
  if (customVoiceId && elevenLabsApiKey && !isHC) {
    console.log(`[TTS] Scene ${scene.number}: English + Clone → ElevenLabs TTS`);
    const result = await generateElevenLabsTTS(
      voiceoverText, scene.number, customVoiceId, elevenLabsApiKey, projectId,
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: ElevenLabs TTS (clone)`);
      return result;
    }
    return { url: null, error: `ElevenLabs clone TTS failed: ${result.error}` };
  }

  // ========== CASE 3: Haitian Creole Standard ==========
  // Gemini TTS ONLY — no STS, no fallback
  if (isHC && googleApiKeys.length > 0) {
    console.log(`[TTS] Scene ${scene.number}: HC standard → Gemini TTS (male Enceladus)`);
    const result = await generateGeminiTTS(voiceoverText, scene.number, googleApiKeys, projectId);
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Gemini TTS (HC standard)`);
      return { ...result, provider: "Gemini TTS (HC standard)" };
    }
    return { url: null, error: `HC Gemini TTS failed: ${result.error}` };
  }

  // ========== CASE 3b: French Male ==========
  // FishAudio with French male model (primary + fallback voice)
  if (isFR && voiceGender === "male" && fishAudioApiKey) {
    console.log(`[TTS] Scene ${scene.number}: French Male → Fish Audio (FR male primary)`);
    const result = await generateFishAudioTTS(
      voiceoverText, scene.number, fishAudioApiKey, projectId, "1c86c56391ab4fefb7d376c86c0cf605",
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish Audio (French male)`);
      return { ...result, provider: "Fish Audio (French male)" };
    }
    // Fallback French male voice
    console.warn(`[TTS] Scene ${scene.number}: FR male primary failed, trying fallback voice`);
    const fallback = await generateFishAudioTTS(
      voiceoverText, scene.number, fishAudioApiKey, projectId, "1cda4ad9a4db4e8b8358a6950e22ac03",
    );
    if (fallback.url) {
      console.log(`✅ Scene ${scene.number}: Fish Audio (French male fallback)`);
      return { ...fallback, provider: "Fish Audio (French male fallback)" };
    }
    return { url: null, error: `French male Fish Audio failed: ${fallback.error}` };
  }

  // ========== CASE 3c: French Female ==========
  // FishAudio with French female voice (config OR auto-detected)
  if (isFR && fishAudioApiKey) {
    console.log(`[TTS] Scene ${scene.number}: French Female → Fish Audio (FR female voice)`);
    const result = await generateFishAudioTTS(
      voiceoverText, scene.number, fishAudioApiKey, projectId, "42fe8376b029438e81dd2929c0889ce1",
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish Audio (French female)`);
      return { ...result, provider: "Fish Audio (French female)" };
    }
    return { url: null, error: `French female Fish Audio failed: ${result.error}` };
  }

  // French with no Fish Audio API key — can't generate, don't fall through to English
  if (isFR) {
    return { url: null, error: "French TTS requires Fish Audio API key (FISH_AUDIO_API_KEY)" };
  }

  // ========== CASE 4: English Male ==========
  // LemonFox → Chatterbox (Replicate)
  if (voiceGender === "male") {
    if (lemonfoxApiKey) {
      console.log(`[TTS] Scene ${scene.number}: English Male → LemonFox`);
      const result = await generateLemonfoxTTS(voiceoverText, scene.number, "male", lemonfoxApiKey, projectId);
      if (result.url) {
        console.log(`✅ Scene ${scene.number}: LemonFox (male)`);
        return result;
      }
      console.warn(`[TTS] Scene ${scene.number}: LemonFox failed (${result.error}), Chatterbox fallback`);
    }
    if (replicateApiKey) {
      const fb = await generateChatterboxTTS(voiceoverText, scene.number, "male", replicateApiKey, projectId);
      if (fb.url) {
        console.log(`✅ Scene ${scene.number}: Chatterbox (male fallback)`);
        return fb;
      }
    }
    return { url: null, error: "English male: LemonFox + Chatterbox both failed" };
  }

  // ========== CASE 5: English Female ==========
  // Fish Audio → Chatterbox (Replicate)
  if (fishAudioApiKey) {
    console.log(`[TTS] Scene ${scene.number}: English Female → Fish Audio`);
    const result = await generateFishAudioTTS(voiceoverText, scene.number, fishAudioApiKey, projectId);
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish Audio (female)`);
      return result;
    }
    console.warn(`[TTS] Scene ${scene.number}: Fish Audio failed (${result.error}), Chatterbox fallback`);
  }
  if (replicateApiKey) {
    const fb = await generateChatterboxTTS(voiceoverText, scene.number, "female", replicateApiKey, projectId);
    if (fb.url) {
      console.log(`✅ Scene ${scene.number}: Chatterbox (female fallback)`);
      return fb;
    }
  }
  return { url: null, error: "English female: Fish Audio + Chatterbox both failed" };
}
