/**
 * Smallest.ai Lightning v3.1 TTS integration (ADDITIVE — testing phase).
 *
 * Endpoint: POST https://api.smallest.ai/waves/v1/lightning-v3.1/get_speech
 * Auth:    Bearer $SMALLEST_API_KEY
 * Output:  44.1 kHz WAV / MP3 / PCM / mulaw (mono)
 *
 * This service is wired in ALONGSIDE the existing Fish Audio / LemonFox /
 * Gemini chain — it does NOT replace any existing provider. Voice IDs are
 * routed here from the audio handlers when the chosen speaker is prefixed
 * with `sm:` (e.g. `sm:olivia`), so nothing else changes if the user picks
 * a legacy speaker.
 *
 * Languages supported by the model: en, es, hi, ta, kn, te, ml, mr, gu,
 * fr (beta), it (beta), nl (beta), sv (beta), pt (beta), de (beta).
 * With `language: "auto"` the model detects from input text.
 */

import { supabase } from "../lib/supabase.js";
import { writeApiLog } from "../lib/logger.js";
import { v4 as uuidv4 } from "uuid";

/** Smallest has multiple model generations. Lightning v3.1 is the current
 *  flagship with the best English/Spanish/Hindi/Indian voices. Lightning v2
 *  is the previous generation but still holds the European voice catalog
 *  (French, German, Italian, Dutch) — those voices weren't ported into v3.1.
 *
 *  We pick the model per voice via its prefix:
 *    - sm:*   → lightning-v3.1 (default — English, Spanish, Hindi, Indian)
 *    - sm2:*  → lightning-v2    (European — French, German, Italian, Dutch)
 *
 *  Both endpoints share the same request/response shape. */
const SMALLEST_V31_URL = "https://api.smallest.ai/waves/v1/lightning-v3.1/get_speech";
const SMALLEST_V2_URL  = "https://api.smallest.ai/waves/v1/lightning-v2/get_speech";

/** Smallest-supported language codes. Values mirror the `language` param
 *  accepted by the API; "auto" lets the model detect from text. */
const SMALLEST_LANGUAGE_MAP: Record<string, string> = {
  en: "en", es: "es", hi: "hi", ta: "ta", kn: "kn", te: "te", ml: "ml",
  mr: "mr", gu: "gu", fr: "fr", it: "it", nl: "nl", sv: "sv", pt: "pt",
  de: "de",
  // Unsupported — fall back to auto-detect; caller should not route here
  // for Haitian Creole but we keep the fallthrough safe.
  ht: "auto",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Process-wide concurrency limiter ───────────────────────────────
// Smallest docs: "100ms latency at 20 concurrent requests" — generous,
// but capping at 6 keeps us aligned with the other TTS providers'
// behavior in this codebase and leaves headroom for bursts.
const SMALLEST_MAX_CONCURRENT = 6;
let _smallestActive = 0;
const _smallestQueue: Array<() => void> = [];

function acquireSmallestSlot(): Promise<void> {
  if (_smallestActive < SMALLEST_MAX_CONCURRENT) {
    _smallestActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _smallestQueue.push(() => { _smallestActive++; resolve(); });
  });
}

function releaseSmallestSlot(): void {
  _smallestActive--;
  const next = _smallestQueue.shift();
  if (next) next();
}

// ── Storage upload ────────────────────────────────────────────────
async function uploadAudio(
  bytes: Uint8Array,
  contentType: string,
  projectId: string,
  sceneNumber: number,
): Promise<string> {
  const ext = contentType.includes("mpeg") ? "mp3" : "wav";
  const name = `scene-${sceneNumber}-smallest-${Date.now()}-${uuidv4().slice(0, 8)}.${ext}`;
  const filePath = `${projectId}/${name}`;

  const { error } = await supabase.storage
    .from("audio")
    .upload(filePath, bytes, { contentType, upsert: true });
  if (error) throw new Error(`Smallest audio upload failed: ${error.message}`);

  const { data: signed, error: signErr } = await supabase.storage
    .from("audio")
    .createSignedUrl(filePath, 604800); // 7 days
  if (signErr || !signed?.signedUrl) {
    throw new Error(`Smallest signed URL failed: ${signErr?.message}`);
  }
  return signed.signedUrl;
}

/** Parse Retry-After header into milliseconds, clamped to a sane range. */
function parseRetryAfter(hdr: string | null): number {
  if (!hdr) return 0;
  const sec = parseInt(hdr, 10);
  if (Number.isFinite(sec) && sec > 0) return Math.min(sec, 30) * 1000;
  return 0;
}

/** Parse a UI speaker value into its Smallest model + voice id, or null if
 *  the value isn't a Smallest voice. Supports both `sm:` (v3.1) and `sm2:`
 *  (v2) prefixes so the caller doesn't have to know which model hosts
 *  which voice. */
export function extractSmallestVoice(
  speaker: string,
): { model: "lightning-v3.1" | "lightning-v2"; voiceId: string } | null {
  if (speaker.startsWith("sm2:")) {
    const id = speaker.slice(4).trim().toLowerCase();
    return id ? { model: "lightning-v2", voiceId: id } : null;
  }
  if (speaker.startsWith("sm:")) {
    const id = speaker.slice(3).trim().toLowerCase();
    return id ? { model: "lightning-v3.1", voiceId: id } : null;
  }
  return null;
}

/** @deprecated Use {@link extractSmallestVoice} which also reports the model. */
export function extractSmallestVoiceId(speaker: string): string | null {
  const v = extractSmallestVoice(speaker);
  return v?.voiceId ?? null;
}

export interface SmallestTTSOptions {
  /** Text to synthesize (≤250 chars per request, ~140 optimal). */
  text: string;
  /** 1-based scene number for filename uniqueness. */
  sceneNumber: number;
  /** Project UUID for storage pathing. */
  projectId: string;
  /** Smallest voice_id (e.g. "olivia", "magnus"). The `sm:` prefix — if
   *  the caller still has it — is stripped automatically. */
  voiceId: string;
  /** ISO language code matching our app (en, es, hi, …). Mapped to the
   *  model's language param. Defaults to "auto" when unknown. */
  language?: string;
  /** Playback speed 0.5–2.0 (default 1.0). */
  speed?: number;
}

/**
 * Generate audio from Smallest Lightning v3.1.
 *
 * Returns `{ url, durationSeconds, provider }` on success, or `{ url: null,
 * error }` on failure. NEVER throws — callers can fall through to the
 * legacy chain when `url` is null. Mirrors the return shape of
 * `generateFishAudioTTS` / `generateLemonfoxTTS` so handlers can treat all
 * providers uniformly.
 */
export async function generateSmallestTTS(
  opts: SmallestTTSOptions,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const apiKey = (process.env.SMALLEST_API_KEY || "").trim();
  if (!apiKey) return { url: null, error: "SMALLEST_API_KEY not configured" };

  // Accept either "sm:alice", "sm2:alice", or a bare "alice" (legacy callers).
  // Default model when no prefix is provided is lightning-v3.1.
  const parsed = extractSmallestVoice(opts.voiceId) ?? {
    model: "lightning-v3.1" as const,
    voiceId: opts.voiceId.trim().toLowerCase(),
  };
  const { voiceId, model } = parsed;
  if (!voiceId) return { url: null, error: "Smallest TTS: empty voiceId" };
  const apiUrl = model === "lightning-v2" ? SMALLEST_V2_URL : SMALLEST_V31_URL;

  const text = (opts.text || "").trim();
  if (text.length < 2) return { url: null, error: "Smallest TTS: empty text" };

  const language = SMALLEST_LANGUAGE_MAP[opts.language ?? "auto"] ?? "auto";
  const speed = Math.min(2.0, Math.max(0.5, opts.speed ?? 1.0));

  // Use each model's native sample rate: v3.1 is 44.1 kHz, v2 is 24 kHz.
  // Requesting the native rate avoids any server-side resampling artifacts.
  const sampleRate = model === "lightning-v2" ? 24000 : 44100;

  // Request body. `output_format: "mp3"` matches the rest of the pipeline's
  // audio/mpeg uploads and keeps file size down vs raw WAV.
  const body = {
    text,
    voice_id: voiceId,
    language,
    sample_rate: sampleRate,
    speed,
    output_format: "mp3",
  };

  await acquireSmallestSlot();
  const startTime = Date.now();
  try {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          console.warn(`[SmallestTTS] Scene ${opts.sceneNumber}: attempt ${attempt}/${MAX_ATTEMPTS} failed (${res.status}): ${errText.substring(0, 240)}`);

          // 401/403 = bad key, 400/422 = bad request — non-retriable.
          if (res.status === 401 || res.status === 403 || res.status === 400 || res.status === 422) {
            return { url: null, error: `Smallest ${res.status}: ${errText.substring(0, 100)}` };
          }

          // 429 — honor server-provided Retry-After when present, otherwise
          // jittered exponential backoff starting at 2s.
          if (res.status === 429 && attempt < MAX_ATTEMPTS) {
            const headerMs = parseRetryAfter(res.headers.get("retry-after"));
            const base = headerMs > 0 ? headerMs : 2000 * Math.pow(2, attempt - 1);
            const jitter = base * 0.25 * (Math.random() * 2 - 1);
            await sleep(Math.max(500, base + jitter));
            continue;
          }

          if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
            await sleep(1500 * attempt);
            continue;
          }

          return { url: null, error: `Smallest ${res.status}: ${errText.substring(0, 100)}` };
        }

        // Smallest returns raw audio bytes (based on output_format) as the
        // response body — not JSON. Read as arrayBuffer.
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length < 256) {
          console.warn(`[SmallestTTS] Scene ${opts.sceneNumber}: short response (${bytes.length} bytes) — treating as failure`);
          if (attempt < MAX_ATTEMPTS) { await sleep(1500 * attempt); continue; }
          return { url: null, error: `Smallest returned short body (${bytes.length} bytes)` };
        }

        const url = await uploadAudio(bytes, "audio/mpeg", opts.projectId, opts.sceneNumber);
        // Rough duration estimate — MP3 at 128kbps ≈ 16,000 bytes/sec.
        const durationSeconds = Math.max(1, bytes.length / 16000);

        console.log(`[SmallestTTS] Scene ${opts.sceneNumber} ✅ ${model}/${voiceId} (${bytes.length} bytes, ~${durationSeconds.toFixed(1)}s)`);
        writeApiLog({
          userId: undefined, generationId: undefined,
          provider: "smallest", model,
          status: "success", totalDurationMs: Date.now() - startTime,
          cost: 0, error: undefined,
        }).catch((err) => { console.warn('[SmallestTTS] background log failed:', (err as Error).message); });

        return { url, durationSeconds, provider: `Smallest ${model} (${voiceId})` };
      } catch (err) {
        console.warn(`[SmallestTTS] Scene ${opts.sceneNumber}: attempt ${attempt} threw: ${(err as Error).message}`);
        if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
      }
    }

    writeApiLog({
      userId: undefined, generationId: undefined,
      provider: "smallest", model,
      status: "error", totalDurationMs: Date.now() - startTime,
      cost: 0, error: `Smallest TTS failed after ${MAX_ATTEMPTS} attempts`,
    }).catch((err) => { console.warn('[SmallestTTS] background log failed:', (err as Error).message); });
    return { url: null, error: `Smallest TTS failed after ${MAX_ATTEMPTS} attempts` };
  } finally {
    releaseSmallestSlot();
  }
}
