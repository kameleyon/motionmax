/**
 * TTS provider router — STRICT, simplified.
 *
 * Four paths:
 *   1. ANY clone (any language) → Fish Audio s2-pro (multilingual)
 *   2. Named built-in Fish voice (speakerName ∈ NAMED_FISH_VOICES) → Fish Audio s2-pro
 *   3. English + Male standard  → LemonFox (Adam)
 *   4. ANYTHING ELSE            → Google Gemini Flash TTS
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
  /** Caller's worker job id for api_call_logs attribution. */
  jobId?: string | null;
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

// ── Named built-in Fish Audio voices ───────────────────────────────
// These are NOT clones — they're catalog speakers in SpeakerSelector
// that happen to render through Fish s2-pro using a fixed reference_id.
// Handlers thread the picked speaker name into AudioConfig.speakerName
// so we can recognize the choice here without conflating gender.
const NAMED_FISH_VOICES: Record<string, string> = {
  Zuri:     "1127a2a0c8574b75a20d1f8dae12c1b9", // English Female — warm, natural
  Morpheus: "06a8fa125ea54698b0c84feac214abad", // Male — sport chronicle
  Jacynthe: "cd178af6aaef4e7d864a5c8cc5f81a63", // Female — clear, articulate
  Phoebe:   "ea674933d2f7400ca7cd5cb952601b96", // Female — young, social-media
  Eddy:     "f4dfad7feb87423ebb516d43bf49ddb3", // French Male — Fish Audio s2-pro
  Mario:    "d12dae2d272e4b94b0b8e41c96e88c8f", // French Male — Fish Audio s2-pro
  Misko:    "2f549813a2634578b5db3401e61a532d", // French Male — Fish Audio s2-pro
  Robert:   "a5d7dcbb81b4472ea0e240af3edaae7d", // French Male — Fish Audio s2-pro
  Miriam:   "5c0170e52ad745f490b4c997d891b175", // French Female — Fish Audio s2-pro
};

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
    speakerName,
    customVoiceId,
    language,
    userId = null,
    generationId = null,
    jobId = null,
  } = config;

  const attribution = { userId, generationId, jobId };
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

  // ========== CASE 2: Named built-in Fish voice → Fish Audio ==========
  // SpeakerSelector entries that route through Fish s2-pro with a fixed
  // reference_id (Zuri, Morpheus, Jacynthe, Phoebe, …). Distinct from
  // CASE 1 because there's no user_voices row — the id lives in the
  // NAMED_FISH_VOICES table above.
  if (speakerName && NAMED_FISH_VOICES[speakerName]) {
    if (!fishAudioApiKey) {
      return { url: null, error: `${speakerName} requires FISH_AUDIO_API_KEY` };
    }
    const referenceId = NAMED_FISH_VOICES[speakerName];
    console.log(`[TTS] Scene ${scene.number}: ${speakerName} → Fish s2-pro (${referenceId.slice(0, 8)}…)`);
    const result = await generateFishAudioTTS(
      voiceoverText, scene.number, fishAudioApiKey, projectId, referenceId, attribution,
    );
    if (result.url) {
      console.log(`✅ Scene ${scene.number}: Fish s2-pro (${speakerName})`);
      return { ...result, provider: `Fish s2-pro (${speakerName})` };
    }
    return { url: null, error: `${speakerName} Fish Audio failed: ${result.error}` };
  }

  // ========== CASE 3: English Male standard → LemonFox (Adam) ==========
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

  // ========== CASE 4: Everything else → Google Gemini TTS ==========
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
