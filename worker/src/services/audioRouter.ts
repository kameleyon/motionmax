/**
 * TTS provider router — mirrors edge function audioEngine.ts with modifications:
 *
 * CASE 1: HC + Clone        → Gemini TTS → ElevenLabs STS (clone voice)
 * CASE 2: Non-HC/FR + Clone → ElevenLabs TTS (no fallback)
 * CASE 3: HC Standard       → Gemini TTS ONLY (no STS, no fallback)
 * CASE 3b: French Male      → Fish Audio (1cda4ad9…)
 * CASE 3c: French Female    → Fish Audio (42fe8376…)
 * CASE 3d: Spanish Male     → Fish Audio (53042fce…)
 * CASE 3e: Spanish Female   → Fish Audio (cd8052cd…)
 * CASE 4: English Male      → LemonFox (Adam) → Fish Audio (06a8fa…) → Chatterbox (Replicate)
 * CASE 5: English Female    → Fish Audio (c64a90…) → Chatterbox (Replicate)
 *
 * Creole detected from: config.forceHaitianCreole OR isHaitianCreole(text)
 * French detected from: config.language === "fr" OR isFrench(text) auto-detection
 */

import { sanitizeVoiceover, isHaitianCreole, isFrench, isSpanish } from "./audioWavUtils.js";
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
  // Detect Spanish from config OR from voiceover text
  const isES = config.language === "es" || (!isHC && !isFR && isSpanish(voiceoverText));

  if (forceHaitianCreole && !isHaitianCreole(voiceoverText)) {
    console.log(`[TTS] Scene ${scene.number}: Forcing Haitian Creole from presenter_focus`);
  }
  if (!forceHaitianCreole && isHC) {
    console.log(`[TTS] Scene ${scene.number}: Auto-detected Haitian Creole from voiceover text`);
  }
  if (isFR && config.language !== "fr") {
    console.log(`[TTS] Scene ${scene.number}: Auto-detected French from voiceover text`);
  }
  if (isES && config.language !== "es") {
    console.log(`[TTS] Scene ${scene.number}: Auto-detected Spanish from voiceover text`);
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
  // FishAudio with French male voice
  if (isFR && voiceGender === "male" && fishAudioApiKey) {
    console.log(`[TTS] Scene ${scene.number}: French Male → Fish Audio`);
    const result = await generateFishAudioTTS(
      voiceoverText, scene.number, fishAudioApiKey, projectId, "3b6b7ececaa84e60a2adb94c19fd16b2",
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish Audio (French male)`);
      return { ...result, provider: "Fish Audio (French male)" };
    }
    return { url: null, error: `French male Fish Audio failed: ${result.error}` };
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

  // ========== CASE 3d: Spanish Male ==========
  // Fish Audio with Spanish male voice
  if (isES && voiceGender === "male" && fishAudioApiKey) {
    console.log(`[TTS] Scene ${scene.number}: Spanish Male → Fish Audio`);
    const result = await generateFishAudioTTS(
      voiceoverText, scene.number, fishAudioApiKey, projectId, "53042fcee6b84e138e72db017d9e50a6",
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish Audio (Spanish male)`);
      return { ...result, provider: "Fish Audio (Spanish male)" };
    }
    return { url: null, error: `Spanish male Fish Audio failed: ${result.error}` };
  }

  // ========== CASE 3e: Spanish Female ==========
  // Fish Audio with Spanish female voice
  if (isES && fishAudioApiKey) {
    console.log(`[TTS] Scene ${scene.number}: Spanish Female → Fish Audio`);
    const result = await generateFishAudioTTS(
      voiceoverText, scene.number, fishAudioApiKey, projectId, "cd8052cd1a7d4597855710e6754b3fd6",
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish Audio (Spanish female)`);
      return { ...result, provider: "Fish Audio (Spanish female)" };
    }
    return { url: null, error: `Spanish female Fish Audio failed: ${result.error}` };
  }

  // Spanish with no Fish Audio API key
  if (isES) {
    return { url: null, error: "Spanish TTS requires Fish Audio API key (FISH_AUDIO_API_KEY)" };
  }

  // ========== CASE 4: English Male ==========
  // LemonFox (Adam) → Fish Audio (male) → Chatterbox (Replicate)
  if (voiceGender === "male") {
    if (lemonfoxApiKey) {
      console.log(`[TTS] Scene ${scene.number}: English Male → LemonFox (Adam)`);
      const result = await generateLemonfoxTTS(voiceoverText, scene.number, "male", lemonfoxApiKey, projectId);
      if (result.url) {
        console.log(`✅ Scene ${scene.number}: LemonFox Adam (English male)`);
        return result;
      }
      console.warn(`[TTS] Scene ${scene.number}: LemonFox failed (${result.error}), Fish Audio fallback`);
    }
    if (fishAudioApiKey) {
      console.log(`[TTS] Scene ${scene.number}: English Male → Fish Audio (fallback)`);
      const result = await generateFishAudioTTS(
        voiceoverText, scene.number, fishAudioApiKey, projectId, "06a8fa125ea54698b0c84feac214abad",
      );
      if (result.url) {
        console.log(`✅ Scene ${scene.number}: Fish Audio (English male fallback)`);
        return { ...result, provider: "Fish Audio (English male)" };
      }
      console.warn(`[TTS] Scene ${scene.number}: Fish Audio male failed (${result.error}), Chatterbox fallback`);
    }
    if (replicateApiKey) {
      const fb = await generateChatterboxTTS(voiceoverText, scene.number, "male", replicateApiKey, projectId);
      if (fb.url) {
        console.log(`✅ Scene ${scene.number}: Chatterbox (male fallback)`);
        return fb;
      }
    }
    return { url: null, error: "English male: LemonFox + Fish Audio + Chatterbox all failed" };
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
