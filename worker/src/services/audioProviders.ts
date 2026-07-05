/**
 * TTS provider implementations for the Node.js worker.
 * Ported from supabase/functions/_shared/audioEngine.ts.
 * Key change: base64Decode → Buffer.from(str, "base64") via base64ToUint8Array.
 */

import { supabase } from "../lib/supabase.js";
import { v4 as uuidv4 } from "uuid";
import {
  sanitizeVoiceover,
  sanitizeForGeminiTTS,
  splitTextIntoChunks,
  pcmToWav,
  extractPcmFromWav,
  stitchWavBuffers,
  base64ToUint8Array,
} from "./audioWavUtils.js";
import { validateMediaBytes, MediaValidationError } from "../handlers/export/mediaValidator.js";
import { writeApiLog } from "../lib/logger.js";
import { ttsCharsCostUsd, ttsSecondsCostUsd } from "../lib/providerRates.js";
import { retryDbRead } from "../lib/retryClassifier.js";

/**
 * Shared attribution payload threaded from the handler so each
 * api_call_logs row has real userId + generationId. (C-8-5 / C-9-7)
 */
export interface AudioProviderAttribution {
  userId: string | null;
  generationId: string | null;
  jobId: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Storage ────────────────────────────────────────────────────────

/**
 * Upload TTS audio bytes to the `audio` bucket and return a 7-day signed URL.
 *
 * Defence: validates the bytes against audio magic numbers BEFORE uploading.
 * A provider can return HTTP 200 with garbage — JSON error, HTML page, UTF-16
 * text, truncated stream — and the export worker would later fail in ffmpeg
 * with "Header missing" across all scenes. We refuse to upload anything that
 * doesn't look like audio so bad files never pollute storage.
 */
export async function uploadAudio(
  bytes: Uint8Array,
  contentType: string,
  projectId: string,
  sceneNumber: number,
  suffix?: string,
): Promise<string> {
  // Validate before upload. Throws MediaValidationError with diagnostic
  // hex+preview of the first bytes when the content isn't actually audio.
  try {
    validateMediaBytes(bytes, "audio");
  } catch (err) {
    if (err instanceof MediaValidationError) {
      throw new Error(
        `Refusing to upload non-audio bytes to audio/${projectId}/scene-${sceneNumber}` +
        (suffix ? `-${suffix}` : "") +
        ` (${err.reason}): ${err.diagnostic ?? err.message}`,
      );
    }
    throw err;
  }

  const ext = contentType.includes("mpeg") ? "mp3" : "wav";
  const name = suffix ? `scene-${sceneNumber}-${suffix}-${Date.now()}.${ext}` : `scene-${sceneNumber}-${Date.now()}.${ext}`;
  // Use the same "audio" bucket + path pattern as the edge function
  const filePath = `${projectId}/${name}`;

  // upsert:true → idempotent, so a transient DB/pooler blip retries.
  const { error } = await retryDbRead(() =>
    supabase.storage.from("audio").upload(filePath, bytes, { contentType, upsert: true }),
  );

  if (error) throw new Error(`Audio upload failed: ${error.message}`);

  // Return a 7-day signed URL (matching edge function behaviour)
  const { data: signedData, error: signError } = await supabase.storage
    .from("audio")
    .createSignedUrl(filePath, 604800);

  if (signError || !signedData?.signedUrl) {
    throw new Error(`Audio signed URL failed: ${signError?.message}`);
  }

  return signedData.signedUrl;
}

// ── Gemini TTS ─────────────────────────────────────────────────────

const GEMINI_MODELS = [
  { name: "gemini-2.5-pro-preview-tts", label: "2.5 Pro Preview TTS" },
  { name: "gemini-2.5-flash-preview-tts", label: "2.5 Flash Preview TTS" },
];
const KEY_ROTATION_ROUNDS = 5;

async function callGeminiTTSModel(
  text: string, sceneNumber: number, apiKey: string, model: { name: string; label: string }, round: number,
): Promise<{ url: string | null; error?: string; durationSeconds?: number; provider?: string }> {
  let voiceoverText = sanitizeForGeminiTTS(text);
  if (!voiceoverText || voiceoverText.length < 2) return { url: null, error: "No voiceover text" };

  // Promo pattern removal
  const promo = [
    /\b(swiv|follow|like|subscribe|kòmante|comment|pataje|share|abòneman)\b[^.]*\./gi,
    /\b(swiv kont|follow the|like and|share this)\b[^.]*$/gi,
    /\.\s*(swiv|like|pataje|share|follow)[^.]*$/gi,
  ];
  for (const p of promo) voiceoverText = voiceoverText.replace(p, ".");
  voiceoverText = voiceoverText.replace(/\.+/g, ".").replace(/\s+/g, " ").trim();

  if (round > 0) {
    const variations = [
      voiceoverText, "Please narrate the following: " + voiceoverText,
      "Read this story aloud: " + voiceoverText, voiceoverText + " End of narration.",
      "Educational content: " + voiceoverText, "Documentary narration: " + voiceoverText,
    ];
    voiceoverText = variations[round % variations.length];
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `[Speak with natural enthusiasm, warmth, and varied pacing. Use a conversational storytelling tone — sometimes faster with excitement, sometimes slower for emphasis. Breathe naturally between sentences. Sound like a captivating documentary narrator, not a robot reading text.] ${voiceoverText}` }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Enceladus" } } },
        },
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    if (res.status === 429) throw Object.assign(new Error(`Gemini quota exhausted`), { quotaExhausted: true });
    return { url: null, error: `Gemini ${model.label} ${res.status}: ${err.substring(0,100)}` };
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "OTHER") return { url: null, error: "Gemini content filter" };
  if (!candidate?.content?.parts?.[0]?.inlineData?.data) return { url: null, error: "No audio data" };

  let pcm = base64ToUint8Array(candidate.content.parts[0].inlineData.data);
  // Trim trailing silence
  const SILENCE_THRESHOLD = 300;
  let trimEnd = pcm.length;
  for (let i = pcm.length - 2; i >= 0; i -= 2) {
    const sample = Math.abs(((pcm[i] | (pcm[i+1] << 8)) << 16) >> 16);
    if (sample > SILENCE_THRESHOLD) { trimEnd = Math.min(pcm.length, i + 14400); break; }
  }
  if (trimEnd < pcm.length) pcm = pcm.slice(0, trimEnd);

  return { url: "__pcm__", durationSeconds: Math.max(1, pcm.length / 48000), provider: `Gemini ${model.label}`, error: undefined };
  // Note: caller handles wav conversion + upload; return raw data via side-band
  // Actually, return url as placeholder — let the caller handle
}

/**
 * Public Gemini-voice TTS entry point.
 *
 * Primary: OpenRouter `google/gemini-3.1-flash-tts-preview` via the
 * `/v1/audio/speech` endpoint — one key, one request, MP3 bytes back.
 * Avoids the per-Google-Cloud-project access denials that took the
 * native chain offline on 2026-05-25.
 *
 * Fallback: the existing native Gemini key-rotation chain (preserved
 * intact below as `_generateNativeGeminiTTS`). Runs only when the
 * OpenRouter call errors — typical causes: missing OPENROUTER_API_KEY,
 * OpenRouter rejecting a voice name it doesn't recognize, transient
 * upstream errors.
 *
 * Signature is unchanged from the prior pure-native implementation so
 * `audioRouter.ts` (and any other caller) does not need to be touched.
 */
export async function generateGeminiTTS(
  text: string,
  sceneNumber: number,
  googleApiKeys: string[],
  projectId: string,
  /** Voice name. Existing code uses Google names like "Enceladus" /
   *  "Aoede"; whether OpenRouter accepts those vs. OpenAI's catalog
   *  (alloy/echo/etc.) will be visible in the first run's error
   *  surface. Passed through unchanged on both paths. */
  voiceName: string = "Enceladus",
  attribution: AudioProviderAttribution = { userId: null, generationId: null, jobId: null },
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string; pcmBytes?: Uint8Array }> {
  const orResult = await _generateOpenRouterGeminiTTS(
    text, sceneNumber, projectId, voiceName, attribution,
  );
  if (orResult.url) return orResult;
  console.warn(
    `[TTS-Gemini] OpenRouter primary failed (${orResult.error}) — falling back to native Gemini key rotation`,
  );
  return await _generateNativeGeminiTTS(
    text, sceneNumber, googleApiKeys, projectId, voiceName, attribution,
  );
}

/**
 * OpenRouter primary TTS path. POSTs `/v1/audio/speech` with model
 * `google/gemini-3.1-flash-tts-preview` and receives raw MP3 bytes
 * (per the request shape confirmed against OpenRouter's docs on
 * 2026-05-25). Single-shot — no key rotation, no model fallback;
 * the public orchestrator handles the fallback to native Gemini.
 */
async function _generateOpenRouterGeminiTTS(
  text: string,
  sceneNumber: number,
  projectId: string,
  voiceName: string,
  attribution: AudioProviderAttribution,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { url: null, error: "OPENROUTER_API_KEY not configured" };

  let voiceoverText = sanitizeForGeminiTTS(text);
  if (!voiceoverText || voiceoverText.length < 2) return { url: null, error: "No text" };
  // Mirror the promo-removal pass the native path uses so audio quality
  // stays consistent regardless of which backend answered.
  const promo = [
    /\b(swiv|follow|like|subscribe|kòmante|comment|pataje|share|abòneman)\b[^.]*\./gi,
    /\b(swiv kont|follow the|like and|share this)\b[^.]*$/gi,
  ];
  for (const p of promo) voiceoverText = voiceoverText.replace(p, ".");
  voiceoverText = voiceoverText.replace(/\.+/g, ".").replace(/\s+/g, " ").trim();

  const startTime = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://motionmax.io",
        "X-OpenRouter-Title": "MotionMax",
      },
      body: JSON.stringify({
        model: "google/gemini-3.1-flash-tts-preview",
        input: voiceoverText,
        voice: voiceName,
        // CRITICAL: the endpoint's default response_format is `pcm`, not
        // `mp3` (per /docs/api/api-reference/speech/create-audio-speech).
        // We explicitly request mp3 so the returned bytes can be uploaded
        // as audio/mpeg and consumed by downstream ffmpeg without any
        // header-wrapping step. The other allowed value is `pcm`, which
        // would require running it through pcmToWav like the native path.
        response_format: "mp3",
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        url: null,
        error: `OpenRouter TTS ${res.status}: ${errText.slice(0, 200)}`,
      };
    }

    // Response is raw MP3 bytes (we explicitly requested response_format
    // "mp3" above). X-Generation-Id header is the only billing/trace
    // handle the API surfaces; capture it for the log row.
    const contentType = res.headers.get("content-type") || "audio/mpeg";
    const audioBytes = new Uint8Array(await res.arrayBuffer());
    const generationId = res.headers.get("X-Generation-Id");
    if (audioBytes.length === 0) {
      return { url: null, error: "OpenRouter TTS returned empty audio" };
    }

    const url = await uploadAudio(audioBytes, contentType, projectId, sceneNumber);

    // We don't get exact duration from OpenRouter — estimate from byte
    // size assuming ~16 kB/s for mono speech MP3. Downstream ffmpeg
    // probes get the exact value during export, so this is only used
    // for cost logging (close enough at the cents-per-call level).
    const durationSeconds = Math.max(1, audioBytes.length / 16000);
    console.log(
      `[TTS-OpenRouter] Scene ${sceneNumber} ✅ gemini-3.1-flash-tts voice=${voiceName} (${(audioBytes.length / 1024).toFixed(1)}KB, gen=${generationId ?? "?"})`,
    );
    writeApiLog({
      userId: attribution.userId,
      generationId: attribution.generationId,
      jobId: attribution.jobId,
      provider: "openrouter", model: "google/gemini-3.1-flash-tts-preview",
      status: "success", totalDurationMs: Date.now() - startTime,
      // Reusing the gemini_flash_tts seconds rate as an approximation —
      // OpenRouter bills per-token ($1/1M input, $20/1M output) but
      // doesn't return token counts on this endpoint. Within 2× of
      // actual at typical narration lengths; revisit if cost tracking
      // matters for billing.
      cost: ttsSecondsCostUsd("gemini_flash_tts", durationSeconds),
      error: undefined,
    }).catch((err) => { console.warn('[TTS-OpenRouter] background log failed:', (err as Error).message); });
    return {
      url, durationSeconds,
      provider: `OpenRouter Gemini 3.1 Flash TTS (${voiceName})`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url: null, error: `OpenRouter TTS network error: ${msg}` };
  }
}

/**
 * Native Gemini TTS key-rotation chain. Preserved as the fallback for
 * `generateGeminiTTS`. Walks every configured google key × 2 model
 * variants × 5 rounds, with prompt-variation between rounds to dodge
 * the "this exact text didn't synthesize" failure mode.
 */
async function _generateNativeGeminiTTS(
  text: string,
  sceneNumber: number,
  googleApiKeys: string[],
  projectId: string,
  voiceName: string = "Enceladus",
  attribution: AudioProviderAttribution = { userId: null, generationId: null, jobId: null },
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string; pcmBytes?: Uint8Array }> {
  const startTime = Date.now();
  for (let round = 0; round < KEY_ROTATION_ROUNDS; round++) {
    if (round > 0) await sleep(3000 * round);
    for (const apiKey of googleApiKeys) {
      for (const model of GEMINI_MODELS) {
        try {
          let voiceoverText = sanitizeForGeminiTTS(text);
          if (!voiceoverText || voiceoverText.length < 2) return { url: null, error: "No text" };
          const promo = [
            /\b(swiv|follow|like|subscribe|kòmante|comment|pataje|share|abòneman)\b[^.]*\./gi,
            /\b(swiv kont|follow the|like and|share this)\b[^.]*$/gi,
          ];
          for (const p of promo) voiceoverText = voiceoverText.replace(p, ".");
          voiceoverText = voiceoverText.replace(/\.+/g, ".").replace(/\s+/g, " ").trim();

          if (round > 0) {
            const v = ["Please narrate: ", "Read aloud: ", "Educational: ", "Story: "];
            voiceoverText = v[round % v.length] + voiceoverText;
          }

          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent?key=${apiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `[Speak with natural enthusiasm, warmth, and varied pacing. Use a conversational storytelling tone — sometimes faster with excitement, sometimes slower for emphasis. Sound like a captivating documentary narrator.] ${voiceoverText}` }] }],
                generationConfig: {
                  responseModalities: ["AUDIO"],
                  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
                },
              }),
            },
          );

          if (!res.ok) {
            const err = await res.text();
            if (res.status === 429) break; // rotate key
            continue;
          }

          const data = await res.json();
          const candidate = data.candidates?.[0];
          if (candidate?.finishReason === "OTHER" || !candidate?.content?.parts?.[0]?.inlineData?.data) continue;

          let pcm = base64ToUint8Array(candidate.content.parts[0].inlineData.data);
          const SILENCE_THRESHOLD = 300;
          let trimEnd = pcm.length;
          for (let i = pcm.length - 2; i >= 0; i -= 2) {
            const sample = Math.abs(((pcm[i] | (pcm[i+1] << 8)) << 16) >> 16);
            if (sample > SILENCE_THRESHOLD) { trimEnd = Math.min(pcm.length, i + 14400); break; }
          }
          if (trimEnd < pcm.length) pcm = pcm.slice(0, trimEnd);

          const wav = pcmToWav(pcm, 24000, 1, 16);
          const url = await uploadAudio(wav, "audio/wav", projectId, sceneNumber);
          const durationSeconds = Math.max(1, pcm.length / (24000 * 2));
          console.log(`[TTS-Gemini] Scene ${sceneNumber} ✅ ${model.label} voice=${voiceName}`);
          // Gemini Flash TTS bills $0.001/min of synthesized audio.
          writeApiLog({
            userId: attribution.userId,
            generationId: attribution.generationId,
            jobId: attribution.jobId,
            provider: "google_tts", model: model.name,
            status: "success", totalDurationMs: Date.now() - startTime,
            cost: ttsSecondsCostUsd("gemini_flash_tts", durationSeconds),
            error: undefined,
          }).catch((err) => { console.warn('[TTS-Gemini] background log failed:', (err as Error).message); });
          return { url, durationSeconds, provider: `Gemini ${model.label} (${voiceName})` };
        } catch (err: any) {
          if (err?.quotaExhausted) break;
        }
      }
    }
  }
  writeApiLog({
    userId: attribution.userId,
    generationId: attribution.generationId,
    jobId: attribution.jobId,
    provider: "google_tts", model: "gemini-tts-rotation",
    status: "error", totalDurationMs: Date.now() - startTime,
    cost: 0, error: "All Gemini keys exhausted",
  }).catch((err) => { console.warn('[TTS-Gemini] background log failed:', (err as Error).message); });
  return { url: null, error: "All Gemini keys exhausted" };
}

// ── ElevenLabs TTS ─────────────────────────────────────────────────

export async function generateElevenLabsTTS(
  text: string, sceneNumber: number, voiceId: string, apiKey: string, projectId: string,
  attribution: AudioProviderAttribution = { userId: null, generationId: null, jobId: null },
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const sanitized = sanitizeVoiceover(text);
  if (!sanitized || sanitized.length < 2) return { url: null, error: "No text" };

  const startTime = Date.now();
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text: sanitized, model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.25, similarity_boost: 0.8, style: 0.75, use_speaker_boost: true } }),
  });

  if (!res.ok) {
    writeApiLog({
      userId: attribution.userId,
      generationId: attribution.generationId,
      jobId: attribution.jobId,
      provider: "elevenlabs", model: "eleven_multilingual_v2",
      status: "error", totalDurationMs: Date.now() - startTime,
      cost: 0, error: `ElevenLabs TTS ${res.status}`,
    }).catch((err) => { console.warn('[ElevenLabs] background log failed:', (err as Error).message); });
    return { url: null, error: `ElevenLabs TTS ${res.status}` };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const url = await uploadAudio(bytes, "audio/mpeg", projectId, sceneNumber);
  // ElevenLabs bills $0.18/1k characters on the multilingual_v2 model.
  writeApiLog({
    userId: attribution.userId,
    generationId: attribution.generationId,
    jobId: attribution.jobId,
    provider: "elevenlabs", model: "eleven_multilingual_v2",
    status: "success", totalDurationMs: Date.now() - startTime,
    cost: ttsCharsCostUsd("elevenlabs_tts", sanitized.length),
    error: undefined,
  }).catch((err) => { console.warn('[ElevenLabs] background log failed:', (err as Error).message); });
  return { url, durationSeconds: Math.max(1, bytes.length / 16000), provider: "ElevenLabs TTS" };
}

// ── ElevenLabs STS ─────────────────────────────────────────────────

export async function transformElevenLabsSTS(
  sourceUrl: string, voiceId: string, sceneNumber: number, apiKey: string, projectId: string,
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const srcRes = await fetch(sourceUrl);
  if (!srcRes.ok) return { url: null, error: `Download source audio: ${srcRes.status}` };
  const srcBytes = new Uint8Array(await srcRes.arrayBuffer());

  const boundary = `----ElevenLabsSTS${Date.now()}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="source.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    srcBytes,
    enc.encode(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\neleven_multilingual_sts_v2\r\n`),
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="voice_settings"\r\n\r\n{"stability":0.25,"similarity_boost":0.8,"style":0.75,"use_speaker_boost":true}\r\n`),
    enc.encode(`--${boundary}--\r\n`),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.length; }

  const res = await fetch(`https://api.elevenlabs.io/v1/speech-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });

  if (!res.ok) return { url: null, error: `ElevenLabs STS ${res.status}` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  const url = await uploadAudio(bytes, "audio/mpeg", projectId, sceneNumber, "sts");
  return { url, durationSeconds: Math.max(1, bytes.length / 16000), provider: "ElevenLabs STS" };
}

// ── LemonFox TTS ───────────────────────────────────────────────────

// Same story as Fish Audio above — a 15-scene burst into LemonFox
// produces a wave of 429s. Cap concurrency to 4 and honor Retry-After
// with jittered exponential backoff.
const LEMON_MAX_CONCURRENT = 4;
let _lemonActive = 0;
const _lemonQueue: Array<() => void> = [];

function acquireLemonSlot(): Promise<void> {
  if (_lemonActive < LEMON_MAX_CONCURRENT) {
    _lemonActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _lemonQueue.push(() => { _lemonActive++; resolve(); });
  });
}

function releaseLemonSlot(): void {
  _lemonActive--;
  const next = _lemonQueue.shift();
  if (next) next();
}

/**
 * Lemonfox has no published max-input length, but empirically requests
 * past ~4000 characters return truncated audio or 400s. Master-audio
 * scripts for cinematic projects (15+ scenes concatenated) routinely
 * exceed that, so anything longer than `LEMON_CHUNK_THRESHOLD` is
 * split at sentence boundaries and rendered in parallel chunks (same
 * strategy generateGeminiFlashTTSChunked uses). Chunks come back as
 * WAV and we stitch them via the shared `stitchWavBuffers` helper —
 * lossless concat because every chunk shares Lemonfox's fixed
 * 24kHz/mono/16-bit output format. Output is uploaded as audio/wav.
 */
// ~30 seconds of audio per chunk at the 165 WPM pacing anchor used
// across all our TTS paths. Smaller chunks keep each independent
// generation locked to a steady prosody for its full duration —
// short reads can't drift into dramatic delivery the way a 3-minute
// slab can. The stitcher concatenates them losslessly into one master.
const LEMON_CHUNK_THRESHOLD = 500;
const LEMON_CHUNK_TARGET_CHARS = 500;
const LEMON_CHUNK_PARALLELISM = 3;

/** Single Lemonfox API call with retry/backoff. Used by both the
 *  short-text path and each chunk of the long-text path. Returns raw
 *  bytes in the requested response_format. */
async function lemonfoxOneShot(
  text: string,
  voice: string,
  apiKey: string,
  responseFormat: "mp3" | "wav",
): Promise<{ bytes: Uint8Array | null; error?: string }> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch("https://api.lemonfox.ai/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, voice, response_format: responseFormat, speed: 1.05 }),
    });
    if (!res.ok) {
      console.warn(`[Lemonfox] Attempt ${attempt}/${MAX_ATTEMPTS} failed (${res.status})`);
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryHeader = res.headers.get("retry-after");
        const retrySec = retryHeader ? Math.min(parseInt(retryHeader, 10) || 0, 30) : 0;
        const base = retrySec > 0 ? retrySec * 1000 : 3000 * Math.pow(2, attempt - 1);
        const jitter = base * 0.25 * (Math.random() * 2 - 1);
        await sleep(Math.max(1000, base + jitter));
        continue;
      }
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        await sleep(2000 * attempt);
        continue;
      }
      return { bytes: null, error: `Lemonfox ${res.status}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100) return { bytes: null, error: "Empty audio" };
    return { bytes };
  }
  return { bytes: null, error: "Lemonfox failed after 5 attempts" };
}

export async function generateLemonfoxTTS(
  text: string, sceneNumber: number, voiceGender: string, apiKey: string, projectId: string,
  attribution: AudioProviderAttribution = { userId: null, generationId: null, jobId: null },
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const sanitized = sanitizeVoiceover(text);
  if (!sanitized) return { url: null, error: "No text" };
  // `voiceGender` accepts either a gender ("male"/"female") or an explicit
  // voice name ("onyx"/"puck"/"river"/"adam"). "male" → adam; a known
  // explicit voice passes through; anything else → river.
  const KNOWN_VOICES = new Set(["adam", "river", "onyx", "puck"]);
  const voice = voiceGender === "male"
    ? "adam"
    : KNOWN_VOICES.has(voiceGender)
      ? voiceGender
      : "river";

  // ─── Long-text path — chunked WAV rendering (master audio, etc.) ───
  // Mirrors generateGeminiFlashTTSChunked. The "Adam" English-male
  // path used to send a multi-scene master script in one Lemonfox
  // call and either truncate or 400 around 4000 chars. Now we split
  // at sentence boundaries, render in parallel under the global
  // concurrency cap, and stitch the resulting WAVs into one master.
  if (sanitized.length > LEMON_CHUNK_THRESHOLD) {
    const startTime = Date.now();
    const chunks = splitTextIntoChunks(sanitized, LEMON_CHUNK_TARGET_CHARS);
    console.log(`[Lemonfox] ${sanitized.length} chars → ${chunks.length} chunk(s) (~${LEMON_CHUNK_TARGET_CHARS} chars each) for ${voice}`);

    const wavBuffers = new Array<Uint8Array | null>(chunks.length).fill(null);
    let firstError: string | null = null;
    let nextIdx = 0;

    async function worker(): Promise<void> {
      while (true) {
        const idx = nextIdx++;
        if (idx >= chunks.length) return;
        if (firstError) return;
        // Each chunk takes a concurrency slot so we don't exceed
        // Lemonfox's per-account rate ceiling when multiple master
        // audio jobs run at once.
        await acquireLemonSlot();
        try {
          const { bytes, error } = await lemonfoxOneShot(chunks[idx], voice, apiKey, "wav");
          if (!bytes) {
            if (!firstError) firstError = `Chunk ${idx + 1}/${chunks.length} failed: ${error ?? "unknown"}`;
            return;
          }
          wavBuffers[idx] = bytes;
        } finally {
          releaseLemonSlot();
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(LEMON_CHUNK_PARALLELISM, chunks.length) }, () => worker()),
    );

    if (firstError) {
      writeApiLog({
        userId: attribution.userId,
        generationId: attribution.generationId,
        jobId: attribution.jobId,
        provider: "lemonfox", model: `lemonfox-${voice}-chunked`,
        status: "error", totalDurationMs: Date.now() - startTime,
        cost: 0, error: firstError,
      }).catch((err) => { console.warn('[Lemonfox] background log failed:', (err as Error).message); });
      return { url: null, error: firstError };
    }
    if (wavBuffers.some((b) => b === null)) {
      return { url: null, error: "One or more Lemonfox chunks returned no audio" };
    }

    // Stitch — extractPcmFromWav handles every chunk; pcmToWav rewraps
    // the merged stream. All chunks are 24kHz/mono/16-bit so the
    // header inferred from chunk 0 applies to the whole master.
    const merged = stitchWavBuffers(wavBuffers as Uint8Array[]);
    const url = await uploadAudio(merged, "audio/wav", projectId, sceneNumber);

    // PCM data length / byteRate = duration in seconds (24kHz mono 16-bit
    // → 48000 byteRate). Use extractPcmFromWav for an exact figure.
    const { pcm, sampleRate, numChannels, bitsPerSample } = extractPcmFromWav(merged);
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const durationSeconds = Math.max(1, Math.round(pcm.length / byteRate));

    writeApiLog({
      userId: attribution.userId,
      generationId: attribution.generationId,
      jobId: attribution.jobId,
      provider: "lemonfox", model: `lemonfox-${voice}-chunked`,
      status: "success", totalDurationMs: Date.now() - startTime,
      cost: ttsCharsCostUsd("lemonfox_tts", sanitized.length),
      error: undefined,
    }).catch((err) => { console.warn('[Lemonfox] background log failed:', (err as Error).message); });

    // Display-facing provider label — show only the voice name (Adam /
    // River) without the "Lemonfox" prefix. The api_call_logs row above
    // already records `lemonfox` in the provider column for finops, so
    // we don't need to repeat it in the user-visible label.
    return { url, durationSeconds, provider: `${voice.charAt(0).toUpperCase()}${voice.slice(1)}` };
  }

  // ─── Short-text path — single MP3 call (unchanged) ───
  await acquireLemonSlot();
  const startTime = Date.now();
  try {
    const { bytes, error } = await lemonfoxOneShot(sanitized, voice, apiKey, "mp3");
    if (!bytes) {
      writeApiLog({
        userId: attribution.userId,
        generationId: attribution.generationId,
        jobId: attribution.jobId,
        provider: "lemonfox", model: `lemonfox-${voice}`,
        status: "error", totalDurationMs: Date.now() - startTime,
        cost: 0, error: error ?? "Lemonfox failed",
      }).catch((err) => { console.warn('[Lemonfox] background log failed:', (err as Error).message); });
      return { url: null, error: error ?? "Lemonfox failed" };
    }
    const url = await uploadAudio(bytes, "audio/mpeg", projectId, sceneNumber);
    // LemonFox bills $0.08/1k characters of input text.
    writeApiLog({
      userId: attribution.userId,
      generationId: attribution.generationId,
      jobId: attribution.jobId,
      provider: "lemonfox", model: `lemonfox-${voice}`,
      status: "success", totalDurationMs: Date.now() - startTime,
      cost: ttsCharsCostUsd("lemonfox_tts", sanitized.length),
      error: undefined,
    }).catch((err) => { console.warn('[Lemonfox] background log failed:', (err as Error).message); });
    return { url, durationSeconds: Math.max(1, bytes.length / 16000), provider: `${voice.charAt(0).toUpperCase()}${voice.slice(1)}` };
  } finally {
    releaseLemonSlot();
  }
}

// ── Fish Audio TTS ─────────────────────────────────────────────────

const FISH_AUDIO_FEMALE_VOICE = "c64a9003acb44737ae2a2d548c772b91";
const FISH_AUDIO_MALE_VOICE = "06a8fa125ea54698b0c84feac214abad";

// Process-wide concurrency limiter. When 12-15 scene audio jobs all
// enter generateFishAudioTTS at the same time, Fish Audio returns 429
// for most of them (observed in prod with 9× "Attempt 1 failed (429)"
// lines at once). Capping to 3 concurrent calls keeps us comfortably
// under their per-account rate ceiling while still finishing a 15-scene
// generation in roughly (15/3)×~3s ≈ 15s of audio time.
const FISH_MAX_CONCURRENT = 3;
let _fishActive = 0;
const _fishQueue: Array<() => void> = [];

function acquireFishSlot(): Promise<void> {
  if (_fishActive < FISH_MAX_CONCURRENT) {
    _fishActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _fishQueue.push(() => { _fishActive++; resolve(); });
  });
}

function releaseFishSlot(): void {
  _fishActive--;
  const next = _fishQueue.shift();
  if (next) next();
}

/** Parse Fish Audio's Retry-After header (or body), clamped. Fish Audio
 *  doesn't put retry-after in the JSON body, but if the header is present
 *  we honor it so we don't retry faster than the server wants. */
function parseFishRetryAfter(headerVal: string | null): number {
  if (!headerVal) return 0;
  const sec = parseInt(headerVal, 10);
  if (Number.isFinite(sec) && sec > 0) return Math.min(sec, 30);
  return 0;
}

// Fish Audio chunking parity with Gemini / Lemonfox: ~30s slabs of
// audio per call so prosody can't drift mid-take and each chunk
// renders fast. Chunks come back as WAV (lossless) and are stitched
// into one master via stitchWavBuffers — same path Lemonfox uses.
const FISH_CHUNK_THRESHOLD = 500;
const FISH_CHUNK_TARGET_CHARS = 500;
const FISH_CHUNK_PARALLELISM = 3;

/** Single Fish Audio API call with retry/backoff. Factored out so the
 *  short-text MP3 path and the chunked WAV-stitch path share the
 *  retry semantics. Returns raw bytes in the requested format. */
async function fishOneShot(
  text: string,
  referenceId: string,
  apiKey: string,
  format: "mp3" | "wav",
): Promise<{ bytes: Uint8Array | null; error?: string }> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", model: "s2-pro" },
      body: JSON.stringify({
        text,
        reference_id: referenceId,
        format,
        sample_rate: 44100,
        mp3_bitrate: 192,
        normalize: true,
        prosody: { speed: 1, normalize_loudness: true },
        temperature: 0.8,
        top_p: 0.8,
        latency: "normal",
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[FishAudio] Attempt ${attempt}/${MAX_ATTEMPTS} failed (${res.status}): ${errBody.substring(0, 200)}`);
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfter = parseFishRetryAfter(res.headers.get("retry-after"));
        const base = retryAfter > 0 ? retryAfter * 1000 : 3000 * Math.pow(2, attempt - 1);
        const jitter = base * 0.25 * (Math.random() * 2 - 1);
        await sleep(Math.max(1000, base + jitter));
        continue;
      }
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        await sleep(2000 * attempt);
        continue;
      }
      return { bytes: null, error: `Fish Audio ${res.status}: ${errBody.substring(0, 100)}` };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 100) return { bytes: null, error: "Empty audio" };
    return { bytes };
  }
  return { bytes: null, error: "Fish Audio failed after 5 attempts" };
}

export async function generateFishAudioTTS(
  text: string, sceneNumber: number, apiKey: string, projectId: string, voiceId?: string,
  attribution: AudioProviderAttribution = { userId: null, generationId: null, jobId: null },
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const referenceId = voiceId || FISH_AUDIO_FEMALE_VOICE;

  // ─── Long-text path — chunked WAV rendering, mirror of Lemonfox ───
  // Same 500-char (~30s) slabs, same stitch helper. Keeps cloned-voice
  // master_audio renders from drifting prosody mid-take.
  if (text.length > FISH_CHUNK_THRESHOLD) {
    const startTime = Date.now();
    const chunks = splitTextIntoChunks(text, FISH_CHUNK_TARGET_CHARS);
    console.log(`[FishAudio] ${text.length} chars → ${chunks.length} chunk(s) (~${FISH_CHUNK_TARGET_CHARS} chars each) for voice ${referenceId.substring(0, 8)}…`);

    const wavBuffers = new Array<Uint8Array | null>(chunks.length).fill(null);
    let firstError: string | null = null;
    let nextIdx = 0;

    async function worker(): Promise<void> {
      while (true) {
        const idx = nextIdx++;
        if (idx >= chunks.length) return;
        if (firstError) return;
        await acquireFishSlot();
        try {
          const { bytes, error } = await fishOneShot(chunks[idx], referenceId, apiKey, "wav");
          if (!bytes) {
            if (!firstError) firstError = `Chunk ${idx + 1}/${chunks.length} failed: ${error ?? "unknown"}`;
            return;
          }
          wavBuffers[idx] = bytes;
        } finally {
          releaseFishSlot();
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(FISH_CHUNK_PARALLELISM, chunks.length) }, () => worker()),
    );

    if (firstError) {
      writeApiLog({
        userId: attribution.userId,
        generationId: attribution.generationId,
        jobId: attribution.jobId,
        provider: "fish_audio", model: "s2-pro-chunked",
        status: "error", totalDurationMs: Date.now() - startTime,
        cost: 0, error: firstError,
      }).catch((err) => { console.warn('[FishAudio] background log failed:', (err as Error).message); });
      return { url: null, error: firstError };
    }
    if (wavBuffers.some((b) => b === null)) {
      return { url: null, error: "One or more Fish Audio chunks returned no audio" };
    }

    const merged = stitchWavBuffers(wavBuffers as Uint8Array[]);
    const url = await uploadAudio(merged, "audio/wav", projectId, sceneNumber);
    const { pcm, sampleRate, numChannels, bitsPerSample } = extractPcmFromWav(merged);
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const durationSeconds = Math.max(1, Math.round(pcm.length / byteRate));

    writeApiLog({
      userId: attribution.userId,
      generationId: attribution.generationId,
      jobId: attribution.jobId,
      provider: "fish_audio", model: "s2-pro-chunked",
      status: "success", totalDurationMs: Date.now() - startTime,
      cost: ttsCharsCostUsd("fish_audio_tts", text.length),
      error: undefined,
    }).catch((err) => { console.warn('[FishAudio] background log failed:', (err as Error).message); });

    return { url, durationSeconds, provider: `Fish s2-pro (${chunks.length} chunks)` };
  }

  // ─── Short-text path — single MP3 call (unchanged) ───
  // Gate concurrency so we don't burst all scenes at once.
  await acquireFishSlot();
  const startTime = Date.now();
  try {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // s2-pro is Fish's current top-tier TTS (80+ languages, 100ms TTFB,
      // higher fidelity than the older s2 / s1 models). Quality knobs:
      //   - sample_rate 44100 (CD quality, Fish default)
      //   - mp3_bitrate 192 (high quality, doubles the 128 default)
      //   - prosody.normalize_loudness: true → consistent volume across
      //     scenes (eliminates the per-scene loudness drift we used to
      //     get when stitching multiple TTS calls together)
      const res = await fetch("https://api.fish.audio/v1/tts", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", model: "s2-pro" },
        body: JSON.stringify({
          text,
          reference_id: referenceId,
          format: "mp3",
          sample_rate: 44100,
          mp3_bitrate: 192,
          normalize: true,
          prosody: { speed: 1, normalize_loudness: true },
          temperature: 0.8,
          top_p: 0.8,
          latency: "normal",
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.warn(`[FishAudio] Attempt ${attempt}/${MAX_ATTEMPTS} failed (${res.status}): ${errBody.substring(0, 300)}`);
        if (res.status === 429 && attempt < MAX_ATTEMPTS) {
          // Prefer server-provided Retry-After when present; otherwise
          // exponential backoff starting at 3s (3, 6, 12, 24s). Add ±25%
          // jitter so parallel retries don't re-sync into the next 429.
          const retryAfter = parseFishRetryAfter(res.headers.get("retry-after"));
          const base = retryAfter > 0 ? retryAfter * 1000 : 3000 * Math.pow(2, attempt - 1);
          const jitter = base * 0.25 * (Math.random() * 2 - 1);
          await sleep(Math.max(1000, base + jitter));
          continue;
        }
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          await sleep(2000 * attempt);
          continue;
        }
        writeApiLog({
          userId: attribution.userId,
          generationId: attribution.generationId,
          jobId: attribution.jobId,
          provider: "fish_audio", model: "s2-pro",
          status: "error", totalDurationMs: Date.now() - startTime,
          cost: 0, error: `Fish Audio ${res.status}`,
        }).catch((err) => { console.warn('[FishAudio] background log failed:', (err as Error).message); });
        return { url: null, error: `Fish Audio ${res.status}: ${errBody.substring(0, 100)}` };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 100) {
        writeApiLog({
          userId: attribution.userId,
          generationId: attribution.generationId,
          jobId: attribution.jobId,
          provider: "fish_audio", model: "s2-pro",
          status: "error", totalDurationMs: Date.now() - startTime,
          cost: 0, error: "Empty audio",
        }).catch((err) => { console.warn('[FishAudio] background log failed:', (err as Error).message); });
        return { url: null, error: "Empty audio" };
      }
      const url = await uploadAudio(bytes, "audio/mpeg", projectId, sceneNumber);
      // Fish Audio bills $0.10 per 1k characters on the s2-pro tier.
      writeApiLog({
        userId: attribution.userId,
        generationId: attribution.generationId,
        jobId: attribution.jobId,
        provider: "fish_audio", model: "s2-pro",
        status: "success", totalDurationMs: Date.now() - startTime,
        cost: ttsCharsCostUsd("fish_audio_tts", text.length),
        error: undefined,
      }).catch((err) => { console.warn('[FishAudio] background log failed:', (err as Error).message); });
      return { url, durationSeconds: Math.max(1, bytes.length / 16000), provider: "Fish Audio TTS" };
    }
    writeApiLog({
      userId: attribution.userId,
      generationId: attribution.generationId,
      jobId: attribution.jobId,
      provider: "fish_audio", model: "s2-pro",
      status: "error", totalDurationMs: Date.now() - startTime,
      cost: 0, error: "Fish Audio failed after 5 attempts",
    }).catch((err) => { console.warn('[FishAudio] background log failed:', (err as Error).message); });
    return { url: null, error: "Fish Audio failed after 5 attempts" };
  } finally {
    releaseFishSlot();
  }
}

