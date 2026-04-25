/**
 * TTS provider router — STRICT per-voice routing.
 *
 * Haitian Creole is the ONLY path that retains cross-provider behavior
 * (Gemini → ElevenLabs STS for clone) because the user asked us to keep
 * the existing Creole setup unchanged. Every other voice uses exactly ONE
 * provider and fails the scene if that provider can't deliver — no silent
 * fall-through that would produce a voice in the wrong identity.
 *
 * CASE 1: HC + Clone        → Gemini TTS → ElevenLabs STS (clone voice) [unchanged]
 * CASE 2: Non-HC/FR + Clone → ElevenLabs TTS (no fallback)
 * CASE 3: HC Standard       → Gemini TTS ONLY (no STS, no fallback)     [unchanged]
 * CASE 3b: French Male      → Fish Audio ONLY (no fallback)
 * CASE 3c: French Female    → Fish Audio ONLY (no fallback)
 * CASE 3d: Spanish Male     → Fish Audio ONLY (no fallback)
 * CASE 3e: Spanish Female   → Fish Audio ONLY (no fallback)
 * CASE 4: English Male      → LemonFox (Adam) ONLY (no fallback)
 * CASE 5: English Female    → Fish Audio ONLY (no fallback)
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
  // generateChatterboxTTS removed as an English fallback — strict routing
  // per user request. Keep import commented for quick rollback if needed.
  // generateChatterboxTTS,
} from "./audioProviders.js";
// Qwen3 TTS (Replicate) disabled — kept importing SPEAKER_MAP only in case
// callers still pass a Qwen3-style speakerName; named-speaker routing is no-op'd below.
// import { generateQwen3TTS, SPEAKER_MAP } from "./qwen3TTS.js";

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
  speakerName?: string;           // "Nova" | "Atlas" | "Marcus" etc. — for Qwen3 speaker mapping
  customVoiceId?: string;         // set when voice_type === "custom"
  /** Which provider hosts the cloned voice — 'fish' for new Fish IVC
   *  clones (uses /v1/tts with s2-pro), 'elevenlabs' for legacy clones
   *  that haven't been backfilled. Defaults to 'elevenlabs' for
   *  back-compat with rows that don't have the column populated. */
  customVoiceProvider?: "fish" | "elevenlabs";
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
    customVoiceProvider = "elevenlabs",
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

  // ========== CASE 0: Cloned voice hosted on Fish ==========
  // Fish s2-pro speaks 80+ languages natively — no Gemini-to-STS hop
  // needed even for HC. One round trip, full sentence-level prosody,
  // higher fidelity than the older ElevenLabs path. Falls through to
  // the legacy paths if customVoiceProvider is undefined or fish key
  // is missing so existing ElevenLabs clones keep working.
  if (customVoiceId && customVoiceProvider === "fish" && fishAudioApiKey) {
    console.log(`[TTS] Scene ${scene.number}: Cloned voice → Fish s2-pro (${customVoiceId.slice(0, 8)}…)`);
    const result = await generateFishAudioTTS(
      voiceoverText, scene.number, fishAudioApiKey, projectId, customVoiceId,
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish s2-pro (clone)`);
      return { ...result, provider: "Fish s2-pro (clone)" };
    }
    return { url: null, error: `Fish clone TTS failed: ${result.error}` };
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
  if (isFR && voiceGender === "female" && fishAudioApiKey) {
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

  // ========== CASE 3f: Named Speaker → Qwen3 TTS (DISABLED) ==========
  // Qwen3 on Replicate removed due to rate-limit issues. Named speakers
  // (Nova, Atlas, Marcus, etc.) now fall through to the English male/female
  // chain below (LemonFox / Fish Audio / Chatterbox) based on gender heuristic.
  // Re-enable by restoring the import and this block.

  // ========== CASE 4: English Male ==========
  // LemonFox (Adam) ONLY — no Fish Audio, no Chatterbox fallback. If
  // LemonFox can't deliver, the scene fails and the caller decides how to
  // surface the error. This preserves the speaker identity the user picked.
  if (voiceGender === "male") {
    if (!lemonfoxApiKey) {
      return { url: null, error: "English male (Adam) requires LEMONFOX_API_KEY" };
    }
    console.log(`[TTS] Scene ${scene.number}: English Male → LemonFox (Adam) [strict, no fallback]`);
    const result = await generateLemonfoxTTS(voiceoverText, scene.number, "male", lemonfoxApiKey, projectId);
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: LemonFox Adam (English male)`);
      return result;
    }
    return { url: null, error: `English male (Adam) via LemonFox failed: ${result.error}` };
  }

  // ========== CASE 5: English Female ==========
  // Fish Audio ONLY — no Chatterbox fallback (see above).
  if (!fishAudioApiKey) {
    return { url: null, error: "English female (River) requires FISH_AUDIO_API_KEY" };
  }
  console.log(`[TTS] Scene ${scene.number}: English Female → Fish Audio [strict, no fallback]`);
  const result = await generateFishAudioTTS(voiceoverText, scene.number, fishAudioApiKey, projectId);
  if (result.url) {
    console.log(`✅ Scene ${scene.number}: Fish Audio (female)`);
    return result;
  }
  return { url: null, error: `English female (River) via Fish Audio failed: ${result.error}` };
}
