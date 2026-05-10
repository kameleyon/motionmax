/**
 * TTS provider router — STRICT, simplified.
 *
 * Three paths only:
 *   1. ANY clone (any language) → Fish Audio s2-pro (multilingual)
 *   2. English + Male standard  → LemonFox (Adam)
 *   3. ANYTHING ELSE            → Google Gemini Flash TTS
 *
 * The 11 supported languages (en, fr, es, ht, de, it, nl, ru, zh, ja, ko)
 * all go through Gemini Flash 2.5 TTS — it speaks every one of them
 * natively, so we don't need per-provider per-language wiring. We pick
 * a male/female Gemini voice per scene and let the model handle the
 * language. ElevenLabs is no longer used. Fish Audio is reserved for
 * cloned voices only.
 */

import { sanitizeVoiceover } from "./audioWavUtils.js";
import {
  generateLemonfoxTTS,
  generateFishAudioTTS,
  generateGeminiTTS,
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
  lemonfoxApiKey?: string;
  fishAudioApiKey?: string;
  /** Retained in the type for back-compat with callers that still pass it.
   *  No longer used by the router — ElevenLabs paths were removed. */
  elevenLabsApiKey?: string;
  /** Retained for back-compat — Replicate-based providers no longer routed. */
  replicateApiKey?: string;
  voiceGender?: string;          // "male" | "female"
  /** Retained for back-compat (was used by Qwen3 named-speaker routing). */
  speakerName?: string;
  customVoiceId?: string;        // present iff voice_type === "custom"
  /** Cloned voices route to Fish Audio regardless of this field. Kept for
   *  back-compat with rows still tagging legacy ElevenLabs clones. */
  customVoiceProvider?: "fish" | "elevenlabs";
  /** Retained for back-compat — Gemini handles HC natively, no special path. */
  forceHaitianCreole?: boolean;
  /** "en" | "fr" | "es" | "ht" | "de" | "it" | "nl" | "ru" | "zh" | "ja" | "ko" */
  language?: string;
  /** Caller's user id for api_call_logs attribution. (C-8-5 / C-9-7) */
  userId?: string | null;
  /** Caller's generation id for api_call_logs attribution. */
  generationId?: string | null;
}

export interface AudioResult {
  url: string | null;
  durationSeconds?: number;
  provider?: string;
  error?: string;
}

// ── Gemini voice picks ─────────────────────────────────────────────
// Single male / female default that works across all 11 languages.
// Enceladus has been our HC voice for months — keep that anchor for
// back-compat. Aoede is the most-recommended Gemini female voice.

const GEMINI_MALE_VOICE = "Enceladus";
const GEMINI_FEMALE_VOICE = "Aoede";

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
    lemonfoxApiKey,
    fishAudioApiKey,
    voiceGender = "female",
    customVoiceId,
    language,
    userId = null,
    generationId = null,
  } = config;

  const attribution = { userId, generationId };
  const isEnglish = (language ?? "en") === "en";
  const isMale = voiceGender === "male";

  // ========== CASE 1: ANY clone → Fish Audio ==========
  // Fish s2-pro speaks 80+ languages natively, so a single clone path
  // covers all 11 supported languages. Legacy rows still tagged
  // 'elevenlabs' are now silently routed through Fish — same identity
  // as long as the voice was re-uploaded to Fish (admin tooling).
  if (customVoiceId) {
    if (!fishAudioApiKey) {
      return { url: null, error: "Cloned voice requires FISH_AUDIO_API_KEY" };
    }
    console.log(`[TTS] Scene ${scene.number}: Clone (${customVoiceId.slice(0, 8)}…) → Fish s2-pro`);
    const result = await generateFishAudioTTS(
      voiceoverText, scene.number, fishAudioApiKey, projectId, customVoiceId, attribution,
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish s2-pro (clone)`);
      return { ...result, provider: "Fish s2-pro (clone)" };
    }
    return { url: null, error: `Fish clone TTS failed: ${result.error}` };
  }

  // ========== CASE 2: English Male standard → LemonFox (Adam) ==========
  if (isEnglish && isMale) {
    if (!lemonfoxApiKey) {
      return { url: null, error: "English male (Adam) requires LEMONFOX_API_KEY" };
    }
    console.log(`[TTS] Scene ${scene.number}: English Male → LemonFox (Adam) [strict]`);
    const result = await generateLemonfoxTTS(
      voiceoverText, scene.number, "male", lemonfoxApiKey, projectId, attribution,
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: LemonFox Adam`);
      return result;
    }
    return { url: null, error: `English male (Adam) via LemonFox failed: ${result.error}` };
  }

  // ========== CASE 3: Everything else → Google Gemini TTS ==========
  // Single voice per gender works across all 11 supported languages —
  // Gemini Flash 2.5 is multilingual natively, no per-language voice
  // selection required.
  if (googleApiKeys.length === 0) {
    return { url: null, error: "Google Gemini TTS requires GOOGLE_API_KEY(s)" };
  }
  const voiceName = isMale ? GEMINI_MALE_VOICE : GEMINI_FEMALE_VOICE;
  console.log(`[TTS] Scene ${scene.number}: lang=${language ?? "auto"} gender=${voiceGender} → Gemini (${voiceName})`);
  const result = await generateGeminiTTS(
    voiceoverText, scene.number, googleApiKeys, projectId, voiceName, attribution,
  );
  if (result.url) {
    console.log(`✅ Scene ${scene.number}: Gemini ${voiceName} (${language ?? "auto"})`);
    return { ...result, provider: result.provider ?? `Gemini ${voiceName}` };
  }
  return { url: null, error: `Gemini TTS failed: ${result.error}` };
}
