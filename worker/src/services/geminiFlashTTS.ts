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

// Per Google's official Gemini TTS prompting guide
// (https://ai.google.dev/gemini-api/docs/speech-generation#advanced-prompting),
// flat directive blobs underperform a structured prompt with explicit
// AUDIO PROFILE / SCENE / DIRECTOR'S NOTES sections plus a clearly
// labelled `## TRANSCRIPT` boundary. The boundary is critical — without
// it the model sometimes reads the directives ALOUD instead of speaking
// only the transcript ("Prompt classifier false rejections", per docs).
//
// The structured format also gives Gemini room to express performance
// nuance (it knows HOW to read, not just WHAT) which fixes the "always
// sounds like a horror narrator" drift on heavy topics.

function buildDirectivePrompt(text: string, directives?: StyleDirectives): string {
  // Defaults intentionally match a "confident host over coffee" persona.
  // Every line of every section is overridable by the caller via
  // StyleDirectives; we only fall back to defaults when the caller
  // doesn't pass a value for that slot.
  const style =
    directives?.style?.trim() ||
    "Confident, natural, conversational. Sounds like a smart friend explaining the topic over coffee, not a stage actor. Light grin in the voice without being chirpy.";
  const pacing =
    directives?.pacing?.trim() ||
    "Natural conversational pace. Slight rhythm variation between sentences but no theatrical pauses. Push forward through hook lines; relax slightly into reflective moments.";
  const accent =
    directives?.accent?.trim() ||
    "Neutral standard accent appropriate to the language of the transcript.";

  // Hard "do-not" list. These get repeated explicitly in the Director's
  // Notes because Gemini gives more weight to repeated negative
  // instructions than to a single buried rule. Every item we've seen
  // the model drift toward on heavy/occult topics is named.
  const doNot =
    "NO whisper, NO ASMR, NO breathy intimate tone, NO suspenseful pacing, " +
    "NO ominous build-up, NO mysterious hush, NO dramatic theatrical delivery, " +
    "NO movie-trailer narration, NO documentary-narrator gravitas, " +
    "NO performative sighs, NO pregnant pauses, NO whispered punchlines. " +
    "Even if the transcript references heavy / dark / supernatural / occult / " +
    "trauma topics, the DELIVERY stays light and conversational — don't match " +
    "the topic's mood, match a normal coffee-shop conversation.";

  // The `raw` slot lets advanced callers (script-builder character
  // briefs) inject extra constraints without losing the structural
  // wrapper. Appended at the end of Director's Notes, never replaces it.
  const extraNotes = directives?.raw?.trim();

  return [
    "# AUDIO PROFILE: The Host",
    "## Confident, conversational, real human energy",
    "",
    "## THE SCENE: A bright, casual recording space",
    "The host is at a comfortable desk with good light, talking directly to a friend",
    "across the table. They have notes but they're not reading; they're explaining.",
    "There's no studio drama, no ominous lighting, no movie-trailer mood — just a smart",
    "person sharing what they think.",
    "",
    "### DIRECTOR'S NOTES",
    `Style: ${style}`,
    `Pacing: ${pacing}`,
    `Accent: ${accent}`,
    `Hard rules (do not violate): ${doNot}`,
    extraNotes ? `Additional context: ${extraNotes}` : "",
    "",
    // The explicit boundary marker per Gemini docs. Everything before
    // this line is performance direction the model reads but does NOT
    // speak. Everything after is what gets spoken aloud.
    "## TRANSCRIPT",
    text,
  ].filter(Boolean).join("\n");
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
 * Internal PCM-returning version. Same retry / key-rotation behaviour
 * as generateGeminiFlashTTS but returns raw 24kHz/mono/16-bit PCM
 * bytes instead of uploading. Used by the chunked orchestrator so we
 * can concat PCM samples directly (cheap byte append) rather than
 * downloading + decoding + re-encoding through ffmpeg.
 */
export async function generateGeminiFlashTTSPCM(
  opts: GeminiFlashTTSOptions,
): Promise<{ pcm: Uint8Array | null; error?: string }> {
  const rawVoice = extractGeminiFlashVoice(opts.voiceName) ?? opts.voiceName;
  const voiceName = rawVoice.trim();
  if (!voiceName) return { pcm: null, error: "Gemini Flash TTS: empty voiceName" };

  const text = (opts.text || "").trim();
  if (text.length < 2) return { pcm: null, error: "Gemini Flash TTS: empty text" };

  const apiKeys = opts.apiKeys.filter(Boolean);
  if (apiKeys.length === 0) return { pcm: null, error: "Gemini Flash TTS: no GOOGLE_TTS_API_KEY configured" };

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
    const MAX_ATTEMPTS = 5;
    let lastError = "";
    const startOffset = Math.floor(Math.random() * apiKeys.length);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const apiKey = apiKeys[(startOffset + attempt - 1) % apiKeys.length];
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        );

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          lastError = `Gemini Flash TTS ${res.status}: ${errText.substring(0, 200)}`;
          console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber} attempt ${attempt}/${MAX_ATTEMPTS} ${lastError}`);
          if (attempt < MAX_ATTEMPTS) {
            const base = res.status === 429 ? 8000 * attempt : 1500 * attempt;
            await sleep(base + Math.random() * 1000);
            continue;
          }
          break;
        }

        const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> }; finishReason?: string }> };
        const candidate = json.candidates?.[0];
        if (candidate?.finishReason === "SAFETY") {
          return { pcm: null, error: `Gemini Flash TTS finishReason=SAFETY (permanent)` };
        }
        if (candidate?.finishReason === "OTHER") {
          lastError = `Gemini Flash TTS finishReason=OTHER (transient — retrying)`;
          console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber} attempt ${attempt}/${MAX_ATTEMPTS}: ${lastError}`);
          if (attempt < MAX_ATTEMPTS) { await sleep(1500 * attempt); continue; }
          break;
        }

        const b64 = candidate?.content?.parts?.[0]?.inlineData?.data;
        if (!b64 || typeof b64 !== "string") {
          lastError = `Gemini Flash TTS returned no audio data`;
          if (attempt < MAX_ATTEMPTS) { await sleep(1500 * attempt); continue; }
          break;
        }

        const pcm = base64ToUint8Array(b64);
        if (pcm.length < 2000) {
          lastError = `Gemini Flash TTS returned short PCM (${pcm.length} bytes)`;
          if (attempt < MAX_ATTEMPTS) { await sleep(1500 * attempt); continue; }
          break;
        }
        // Light log so the chunked orchestrator can attribute success per chunk.
        console.log(`[GeminiFlashTTS] Chunk for scene-id ${opts.sceneNumber} ✅ voice=${voiceName} (${pcm.length} PCM bytes)`);
        void startTime;
        return { pcm };
      } catch (err) {
        lastError = `Gemini Flash TTS exception: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber} attempt ${attempt} threw: ${lastError}`);
        if (attempt < MAX_ATTEMPTS) { await sleep(2000 * attempt); continue; }
      }
    }
    return { pcm: null, error: lastError || "Gemini Flash TTS failed after retries" };
  } finally {
    releaseGeminiFlashSlot();
  }
}

/**
 * Chunked Gemini TTS for long master audio.
 *
 * Why: Gemini TTS has a hard 32k-token context window per request. A
 * 36-scene master script (~6-8 min of audio output) blows past that
 * because audio output tokens count against the same window — Google
 * fails the request as "quota exceeded" (misleading; it's the
 * per-request window, not the per-minute quota).
 *
 * Per Google's official docs: "Speech quality and consistency may
 * begin to drift with generated outputs that are longer than a few
 * minutes. We recommend splitting your transcripts into smaller chunks."
 *
 * This function splits at sentence boundaries, parallel-calls the TTS
 * with concurrency cap 3 (matches Tier 1 TPM headroom), then concats
 * the raw PCM bytes (cheap — same sample rate / channels / bit depth)
 * and uploads once.
 */
export async function generateGeminiFlashTTSChunked(
  opts: Omit<GeminiFlashTTSOptions, "text"> & {
    /** Full master text — will be chunked internally. */
    masterText: string;
    /** Soft cap per chunk in characters. ~1500 → ~120s of audio →
     *  comfortably under the 32k token window even with audio output
     *  counted in. Tunable. */
    targetChunkChars?: number;
    /** Max parallel chunks in flight at once. 3 is conservative for
     *  Gemini Tier 1 TPM (audio output tokens add up fast). */
    parallelism?: number;
  },
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  const targetChars = opts.targetChunkChars ?? 1500;
  const parallelism = opts.parallelism ?? 3;
  const chunks = chunkBySentences(opts.masterText, targetChars);

  console.log(`[GeminiFlashTTS] Master: chunking ${opts.masterText.length} chars into ${chunks.length} chunk(s) of ~${targetChars} chars each`);

  // Run with concurrency cap. Order matters — we'll concat in chunk
  // order — so we don't fire all in a Promise.all; instead, claim
  // slots and write into a fixed-position result array.
  const pcmResults = new Array<Uint8Array | null>(chunks.length).fill(null);
  let nextIdx = 0;
  let firstError: string | null = null;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= chunks.length) return;
      if (firstError) return; // short-circuit if a sibling already failed

      const result = await generateGeminiFlashTTSPCM({
        ...opts,
        text: chunks[idx],
        // Per-chunk sceneNumber for logging — distinct so retries are
        // attributable to a chunk, not the whole master.
        sceneNumber: -1 - idx,
      });

      if (!result.pcm) {
        if (!firstError) firstError = `Chunk ${idx + 1}/${chunks.length} failed: ${result.error}`;
        return;
      }
      pcmResults[idx] = result.pcm;
    }
  }

  await Promise.all(Array.from({ length: Math.min(parallelism, chunks.length) }, () => worker()));

  if (firstError) return { url: null, error: firstError };
  if (pcmResults.some((p) => p === null)) {
    return { url: null, error: "One or more chunks returned no PCM" };
  }

  // PCM concat — all chunks are 24kHz/mono/16-bit so byte-append is
  // semantically correct. Total bytes = sum of chunk lengths.
  const totalBytes = pcmResults.reduce((acc, p) => acc + (p?.length ?? 0), 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const p of pcmResults) {
    if (!p) continue;
    merged.set(p, offset);
    offset += p.length;
  }

  const wav = pcmToWav(merged, GEMINI_PCM_SAMPLE_RATE, 1, 16);
  const url = await uploadAudio(wav, "audio/wav", opts.projectId, opts.sceneNumber);
  const durationSeconds = Math.max(1, merged.length / (GEMINI_PCM_SAMPLE_RATE * 2));

  console.log(`[GeminiFlashTTS] Master ✅ voice=${opts.voiceName} (${chunks.length} chunks, ${merged.length} PCM bytes, ~${durationSeconds.toFixed(1)}s)`);

  return {
    url,
    durationSeconds,
    provider: `Gemini 3.1 Flash TTS (${extractGeminiFlashVoice(opts.voiceName) ?? opts.voiceName})`,
  };
}

/** Split text into chunks at sentence boundaries, each ≤ targetChars.
 *  Sentence boundary = .!? followed by space/end (covers most prose).
 *  Single sentences longer than targetChars get hard-split at the
 *  nearest space rather than truncated. */
function chunkBySentences(text: string, targetChars: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current.length + s.length <= targetChars) {
      current += s;
    } else {
      if (current.trim()) chunks.push(current.trim());
      // If a single sentence is already too long, hard-split on words.
      if (s.length > targetChars) {
        let buf = "";
        for (const word of s.split(/\s+/)) {
          if (buf.length + word.length + 1 > targetChars) {
            if (buf.trim()) chunks.push(buf.trim());
            buf = word;
          } else {
            buf = buf ? `${buf} ${word}` : word;
          }
        }
        current = buf;
      } else {
        current = s;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
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
