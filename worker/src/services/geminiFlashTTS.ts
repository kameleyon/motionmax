/**
 * Gemini 3.1 Flash TTS integration.
 *
 * Model: gemini-3.1-flash-tts-preview
 * Endpoint: generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * Auth: GOOGLE_TTS_API_KEY (shared with the existing Haitian Creole path, but
 * this service is isolated from it — we NEVER call the HC Enceladus function
 * from here and vice versa).
 *
 * Output: PCM 24 kHz 16-bit mono (per Google's docs). We wrap the PCM into a
 * WAV container before uploading so downstream ffmpeg can probe it like any
 * other audio asset.
 *
 * Style steering: the Gemini TTS family treats the first words of the prompt
 * as a director's note. We prepend a bracketed block describing style,
 * pacing, and accent when the caller supplies them. Example prepend:
 *   [Style: Enthusiastic and Sassy GenZ beauty YouTuber. Pacing: energetic,
 *    rapid short-form-video delivery. Accent: Southern California valley girl
 *    from Laguna Beach.]
 *   {narration text...}
 *
 * No fallbacks — if the call fails after retries, return { url: null, error }.
 * The caller decides how to surface that to the user.
 */

import { supabase } from "../lib/supabase.js";
import { writeApiLog } from "../lib/logger.js";
import { pcmToWav, base64ToUint8Array } from "./audioWavUtils.js";
import { v4 as uuidv4 } from "uuid";

const MODEL = "gemini-3.1-flash-tts-preview";
const GEMINI_PCM_SAMPLE_RATE = 24000; // Per Google docs (PCM 24kHz 16-bit mono)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Concurrency limiter ─────────────────────────────────────────────
// Google's per-key QPS is generous but not infinite. 15 scene jobs firing
// at once across multiple concurrent generations can still burst past the
// limit. Cap at 6 in-flight to match the other TTS providers in this
// codebase (Smallest, Fish, Lemonfox).
const GEMINI_FLASH_MAX_CONCURRENT = 6;
let _gfActive = 0;
const _gfQueue: Array<() => void> = [];

function acquireGeminiFlashSlot(): Promise<void> {
  if (_gfActive < GEMINI_FLASH_MAX_CONCURRENT) {
    _gfActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _gfQueue.push(() => { _gfActive++; resolve(); });
  });
}

function releaseGeminiFlashSlot(): void {
  _gfActive--;
  const next = _gfQueue.shift();
  if (next) next();
}

// ── Storage ────────────────────────────────────────────────────────
async function uploadAudio(
  bytes: Uint8Array,
  contentType: string,
  projectId: string,
  sceneNumber: number,
): Promise<string> {
  const ext = contentType.includes("wav") ? "wav" : "mp3";
  const name = `scene-${sceneNumber}-gflash-${Date.now()}-${uuidv4().slice(0, 8)}.${ext}`;
  const filePath = `${projectId}/${name}`;

  const { error } = await supabase.storage
    .from("audio")
    .upload(filePath, bytes, { contentType, upsert: true });
  if (error) throw new Error(`Gemini Flash TTS upload failed: ${error.message}`);

  const { data: signed, error: signErr } = await supabase.storage
    .from("audio")
    .createSignedUrl(filePath, 604800); // 7 days
  if (signErr || !signed?.signedUrl) {
    throw new Error(`Gemini Flash TTS signed URL failed: ${signErr?.message}`);
  }
  return signed.signedUrl;
}

/** Strip the "gm:" prefix from a speaker value if present. */
export function extractGeminiFlashVoice(speaker: string): string | null {
  if (!speaker.startsWith("gm:")) return null;
  const id = speaker.slice(3).trim();
  return id.length > 0 ? id : null;
}

// ── Style directive block ──────────────────────────────────────────
//
// Gemini TTS reads natural-language direction from the start of the prompt.
// When the caller supplies style / pacing / accent, we compose a bracketed
// directive block in English regardless of the narration language — the
// directive is metadata the model reads, not content it speaks. The
// narration itself follows on the next line in its native language.

export interface StyleDirectives {
  style?: string;
  pacing?: string;
  accent?: string;
  /** Pre-composed free-form directive that overrides the three fields above
   *  if callers want full control (e.g. a character brief from the script). */
  raw?: string;
}

// Hard delivery guardrails prepended to every Gemini TTS request.
// The model reads the script's topic ("tarot", "fate", "the devil", any
// occult/heavy subject) and overweights it — drifts toward suspenseful
// movie-trailer delivery even when the writing is plain. These rules
// pin the delivery to "smart friend over coffee" regardless of subject.
// Applied to initial generation, per-scene regen, AND master_audio.
const NEGATIVE_DELIVERY =
  "Delivery rules — read these literally and ignore the topic's vibe: " +
  "NO whisper, NO ASMR, NO breathy intimate tone, NO suspenseful pacing, " +
  "NO ominous build-up, NO mysterious hush, NO dramatic theatrical delivery, " +
  "NO movie-trailer narration, NO documentary-narrator gravitas, " +
  "NO 'let me tell you a secret' energy, NO performative sighs, " +
  "NO pregnant pauses, NO whispered punchlines. " +
  "Read it like a smart girlfriend explaining the topic to a friend over " +
  "brunch — confident, curious, casual, warm, occasionally funny, NEVER solemn. " +
  "Even if the script mentions heavy / dark / supernatural / occult subjects, " +
  "the DELIVERY stays light and conversational. Don't match the topic's mood — " +
  "match a normal coffee-shop conversation.";

function buildDirectivePrompt(text: string, directives?: StyleDirectives): string {
  if (!directives) {
    return `[${NEGATIVE_DELIVERY}]\n${text}`;
  }

  if (directives.raw && directives.raw.trim()) {
    return `[${NEGATIVE_DELIVERY} ${directives.raw.trim()}]\n${text}`;
  }

  const parts: string[] = [NEGATIVE_DELIVERY];
  if (directives.style?.trim())  parts.push(`Style: ${directives.style.trim()}`);
  if (directives.pacing?.trim()) parts.push(`Pacing: ${directives.pacing.trim()}`);
  if (directives.accent?.trim()) parts.push(`Accent: ${directives.accent.trim()}`);

  return `[${parts.join(" ")}]\n${text}`;
}

export interface GeminiFlashTTSOptions {
  text: string;
  sceneNumber: number;
  projectId: string;
  /** Voice name — accepts "gm:Kore" OR bare "Kore". Case-preserving
   *  because Google's voice names are capitalized. */
  voiceName: string;
  /** ISO language code used by downstream logging only; the model
   *  auto-detects language from the text itself. */
  language?: string;
  /** Optional style/pacing/accent directives injected as a bracketed
   *  block before the narration. */
  directives?: StyleDirectives;
  /** Rotated API keys. Typically
   *  [GOOGLE_TTS_API_KEY_3, GOOGLE_TTS_API_KEY_2, GOOGLE_TTS_API_KEY]. */
  apiKeys: string[];
}

/**
 * Generate speech via Gemini 3.1 Flash TTS.
 *
 * Returns `{ url, durationSeconds, provider }` on success, or
 * `{ url: null, error }` on failure. NEVER falls back to another provider —
 * caller chose this voice, caller gets this voice or an error.
 */
export async function generateGeminiFlashTTS(
  opts: GeminiFlashTTSOptions,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const rawVoice = extractGeminiFlashVoice(opts.voiceName) ?? opts.voiceName;
  const voiceName = rawVoice.trim();
  if (!voiceName) return { url: null, error: "Gemini Flash TTS: empty voiceName" };

  const text = (opts.text || "").trim();
  if (text.length < 2) return { url: null, error: "Gemini Flash TTS: empty text" };

  const apiKeys = opts.apiKeys.filter(Boolean);
  if (apiKeys.length === 0) return { url: null, error: "Gemini Flash TTS: no GOOGLE_TTS_API_KEY configured" };

  const promptText = buildDirectivePrompt(text, opts.directives);

  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };

  await acquireGeminiFlashSlot();
  const startTime = Date.now();
  try {
    // Up to 5 total attempts: round-robin the available keys, with
    // backoff on 429 / 5xx per Google's docs ("Occasional text token
    // returns may trigger 500 errors — implement retry logic").
    //
    // Randomize the STARTING key index per call so no single key
    // gets hammered first across all jobs. Without this, KEY_3 (or
    // whatever's at index 0) eats every job's first attempt and is
    // permanently at-quota — every job logs an attempt-1 429 until
    // it rotates onto a fresher key. Starting at a random offset
    // distributes load evenly across keys instead.
    const MAX_ATTEMPTS = 5;
    let lastError = "";
    const startOffset = Math.floor(Math.random() * apiKeys.length);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const apiKey = apiKeys[(startOffset + attempt - 1) % apiKeys.length];
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          lastError = `Gemini Flash TTS ${res.status}: ${errText.substring(0, 200)}`;
          console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber} attempt ${attempt}/${MAX_ATTEMPTS} ${lastError}`);

          // Non-retriable client errors (bad key, quota, malformed payload).
          if (res.status === 400 || res.status === 401 || res.status === 403) {
            return { url: null, error: lastError };
          }
          // 429 / 5xx → retry with backoff and next key in rotation.
          if (attempt < MAX_ATTEMPTS) {
            const backoff = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s, 16s
            const jitter = backoff * 0.25 * (Math.random() * 2 - 1);
            await sleep(Math.max(1000, backoff + jitter));
            continue;
          }
          return { url: null, error: lastError };
        }

        const data = await res.json() as any;
        const candidate = data?.candidates?.[0];
        // SAFETY = genuine content block, never retriable.
        // OTHER  = Gemini's grab-bag status: transient model hiccup,
        //          content-filter ambiguity, or occasionally a
        //          successful-but-malformed response. Retrying with a
        //          different key + backoff usually works on the next
        //          attempt — treating OTHER as permanent was causing
        //          full generations to fail on recoverable errors.
        if (candidate?.finishReason === "SAFETY") {
          lastError = `Gemini Flash TTS blocked by safety filter (finishReason=SAFETY)`;
          console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber}: ${lastError}`);
          return { url: null, error: lastError };
        }
        if (candidate?.finishReason === "OTHER") {
          lastError = `Gemini Flash TTS finishReason=OTHER (transient — retrying)`;
          console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber} attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
          if (attempt < MAX_ATTEMPTS) { await sleep(1500 * attempt); continue; }
          return { url: null, error: `Gemini Flash TTS: finishReason=OTHER across ${MAX_ATTEMPTS} attempts` };
        }

        const b64 = candidate?.content?.parts?.[0]?.inlineData?.data;
        if (!b64 || typeof b64 !== "string") {
          lastError = `Gemini Flash TTS returned no audio data`;
          console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber} attempt ${attempt}: ${lastError}`);
          if (attempt < MAX_ATTEMPTS) { await sleep(1500 * attempt); continue; }
          return { url: null, error: lastError };
        }

        const pcm = base64ToUint8Array(b64);
        if (pcm.length < 2000) {
          lastError = `Gemini Flash TTS returned short PCM (${pcm.length} bytes)`;
          console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber} attempt ${attempt}: ${lastError}`);
          if (attempt < MAX_ATTEMPTS) { await sleep(1500 * attempt); continue; }
          return { url: null, error: lastError };
        }

        // Wrap raw PCM into a WAV container: 24 kHz, mono, 16-bit (Google's
        // documented output format). The WAV header is what ffmpeg probes
        // during export so we cannot skip this step.
        const wav = pcmToWav(pcm, GEMINI_PCM_SAMPLE_RATE, 1, 16);
        const url = await uploadAudio(wav, "audio/wav", opts.projectId, opts.sceneNumber);
        const durationSeconds = Math.max(1, pcm.length / (GEMINI_PCM_SAMPLE_RATE * 2));

        console.log(`[GeminiFlashTTS] Scene ${opts.sceneNumber} ✅ voice=${voiceName} (${pcm.length} PCM bytes, ~${durationSeconds.toFixed(1)}s)`);
        writeApiLog({
          userId: undefined, generationId: undefined,
          provider: "google_tts", model: MODEL,
          status: "success", totalDurationMs: Date.now() - startTime,
          cost: 0, error: undefined,
        }).catch((err) => { console.warn('[GeminiFlashTTS] background log failed:', (err as Error).message); });

        return {
          url,
          durationSeconds,
          provider: `Gemini 3.1 Flash TTS (${voiceName})`,
        };
      } catch (err) {
        lastError = (err as Error).message;
        console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber} attempt ${attempt} threw: ${lastError}`);
        if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
      }
    }

    writeApiLog({
      userId: undefined, generationId: undefined,
      provider: "google_tts", model: MODEL,
      status: "error", totalDurationMs: Date.now() - startTime,
      cost: 0, error: lastError,
    }).catch((err) => { console.warn('[GeminiFlashTTS] background log failed:', (err as Error).message); });
    return { url: null, error: lastError || `Gemini Flash TTS failed after ${MAX_ATTEMPTS} attempts` };
  } finally {
    releaseGeminiFlashSlot();
  }
}
