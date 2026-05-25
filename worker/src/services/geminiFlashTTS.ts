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
import { ttsSecondsCostUsd } from "../lib/providerRates.js";
import { pcmToWav, base64ToUint8Array } from "./audioWavUtils.js";
import { v4 as uuidv4 } from "uuid";

const MODEL = "gemini-3.1-flash-tts-preview";
const GEMINI_PCM_SAMPLE_RATE = 24000; // Per Google docs (PCM 24kHz 16-bit mono)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Strip ASCII control characters (0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, 0x7F)
 * from text before sending to Gemini. Keeps \t (0x09), \n (0x0A), \r (0x0D)
 * because Google accepts those in prompts. Verified 2026-05-15 incident
 * where chunk 4 of a 5-chunk master read returned HTTP 400 INVALID_ARGUMENT
 * because the chunker boundary left an embedded \x0B (vertical tab) in the
 * carryover-context calibration block. Google's API rejects the whole
 * request on a single bad byte. Cheap defense-in-depth; never alters
 * audible output (control chars don't get spoken anyway).
 */
function stripBadControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Cap on how long a single Gemini fetch is allowed to hang before we
 * abort and move to the next API key. Bumped 60 → 120 s on 2026-05-15
 * after a key rotation surfaced cases where Google legitimately takes
 * 60-90 s to synthesize longer chunks (verified: same prompt that
 * returned in Google AI Studio Playground was being aborted by our
 * 60 s cap before completion). The original 60 s was conservative
 * based on "5-30 s normal" P50, but P95 on longer text is closer to
 * 90 s. 120 s × 5 attempts = 10 min — still leaves 5 min in the
 * 15 min LLM_JOB_TIMEOUT_MS budget for downstream upload + DB writes.
 */
const PER_FETCH_TIMEOUT_MS = 120_000;

/**
 * Compose an outer AbortSignal (from the worker's per-job hard-timeout)
 * with a per-fetch timeout into a single signal handed to fetch.
 *
 * Either source triggers the combined signal — the caller distinguishes
 * which one by checking `outer.aborted` in the catch handler. If outer
 * is aborted, the worker's hard-timeout fired → exit entirely. If only
 * the inner timeout fired → continue to the next retry with a fresh key.
 *
 * The cleanup function MUST be called in a finally block to release the
 * setTimeout handle and the outer signal's listener; otherwise we leak
 * a 60 s timer per attempt under high parallelism.
 */
function combineSignalWithTimeout(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`Gemini fetch timeout ${timeoutMs}ms`)),
    timeoutMs,
  );
  let onOuterAbort: (() => void) | undefined;
  if (outer) {
    if (outer.aborted) {
      ctrl.abort(outer.reason);
    } else {
      onOuterAbort = () => ctrl.abort(outer.reason);
      outer.addEventListener("abort", onOuterAbort, { once: true });
    }
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (outer && onOuterAbort) outer.removeEventListener("abort", onOuterAbort);
    },
  };
}

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

// ── OpenRouter primary path ─────────────────────────────────────────
//
// Single-shot synthesize via OpenRouter's `/v1/audio/speech` endpoint
// against `google/gemini-3.1-flash-tts-preview`. We request PCM so the
// returned bytes are drop-in compatible with the existing
// `pcmToWav` / chunk-concat pipeline — no decode step needed.
//
// Returns raw 24kHz/mono/16-bit PCM bytes on success, or an error
// string on failure. Callers fall back to the native key-rotation
// retry loop on any error here.
async function _openRouterTTSSynthesize(
  voiceoverText: string,
  voiceName: string,
  signal: AbortSignal | undefined,
): Promise<{ pcm: Uint8Array | null; error?: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { pcm: null, error: "OPENROUTER_API_KEY not configured" };

  const { signal: combinedSignal, cleanup } = combineSignalWithTimeout(
    signal, PER_FETCH_TIMEOUT_MS,
  );
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
        model: MODEL,
        // Full directive-prompted text. Gemini's TTS family parses the
        // bracketed AUDIO PROFILE / DIRECTOR'S NOTES block as
        // performance direction and only speaks what's after the
        // `## TRANSCRIPT` marker. Whether OpenRouter's proxy preserves
        // this Gemini-specific behavior is empirical — verify by ear
        // on first deploy. If directives leak into the audio, switch
        // to sending raw transcript text only.
        input: voiceoverText,
        voice: voiceName,
        // CRITICAL: default is "pcm" per docs but we set it explicitly
        // so a future docs-default change doesn't silently break the
        // PCM concat pipeline downstream.
        response_format: "pcm",
      }),
      signal: combinedSignal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        pcm: null,
        error: `OpenRouter TTS ${res.status}: ${errText.substring(0, 200)}`,
      };
    }

    const audioBytes = new Uint8Array(await res.arrayBuffer());
    if (audioBytes.length < 2000) {
      return {
        pcm: null,
        error: `OpenRouter TTS returned short PCM (${audioBytes.length} bytes)`,
      };
    }
    return { pcm: audioBytes };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { pcm: null, error: "OpenRouter TTS aborted" };
    }
    return {
      pcm: null,
      error: `OpenRouter TTS network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    cleanup();
  }
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

function buildDirectivePrompt(
  text: string,
  directives?: StyleDirectives,
  carryOverContext?: string | null,
): string {
  // Defaults intentionally match a "confident host over coffee" persona.
  // Every line of every section is overridable by the caller via
  // StyleDirectives; we only fall back to defaults when the caller
  // doesn't pass a value for that slot.
  const style =
    directives?.style?.trim() ||
    "Confident, natural human conversation — clear and articulate. Sounds like a smart friend explaining the topic over coffee, not a stage actor. Light grin in the voice without being chirpy.";
  // Anchored pacing — Gemini renders independent chunks of a master script
  // as independent generateContent calls, and its prosody baseline drifts
  // between calls without a numeric anchor. Naming an explicit WPM target
  // + steady-anchor reference gives the model the same calibration target
  // every chunk, so chunk N+1 doesn't come out 15-20% faster/slower than
  // chunk N. The "steady" + "165 WPM" framing is what keeps chunks from
  // sounding like two different speakers stitched together.
  const pacing =
    directives?.pacing?.trim() ||
    "natural human conversational tone pace, normal like a documentary, clear, articulate, measured pace throughout, no variation, no whisper, no fast pace, no screaming, no overly dramatic, no bold etonation, no overly emotional tone.";
  const accent =
    directives?.accent?.trim() ||
    "Neutral standard accent appropriate to the language of the transcript.";

  // Hard "do-not" list. These get repeated explicitly in the Director's
  // Notes because Gemini gives more weight to repeated negative
  // instructions than to a single buried rule. Every item we've seen
  // the model drift toward on heavy/occult topics is named.
  const doNot =
    "NO whisper at ANY point — not at the start, not in the middle, not at the end. " +
    "NO trailing off, NO lowering the voice or volume at the end of sentences or phrases, " +
    "NO murmur, NO mumble, NO under-breath delivery, NO soft conclusions, NO fade-outs. " +
    "END every sentence at the SAME volume and energy it started with — flat consistent level. " +
    "NO ASMR, NO breathy intimate tone, NO suspenseful pacing, NO ominous build-up, " +
    "NO mysterious hush, NO dramatic theatrical delivery, NO movie-trailer narration, " +
    "NO documentary-narrator gravitas, NO performative sighs, NO pregnant pauses, " +
    "NO whispered punchlines, NO emotional swells, NO bold intonation spikes. " +
    "Even if the transcript references heavy / dark / supernatural / occult / trauma topics, " +
    "the DELIVERY stays light, even, and conversational — don't match the topic's mood, " +
    "match a normal coffee-shop conversation at a STEADY level the whole way through.";

  // The `raw` slot lets advanced callers (script-builder character
  // briefs) inject extra constraints without losing the structural
  // wrapper. Appended at the end of Director's Notes, never replaces it.
  const extraNotes = directives?.raw?.trim();

  // Carry-over context: when this chunk follows another chunk in the
  // same master read, we paste the previous chunk's last 1-2 sentences
  // here as a calibration anchor. The model reads it to lock onto the
  // SAME prosody (pace, pitch, energy) the previous chunk used, then
  // continues the read from the TRANSCRIPT marker — but does NOT speak
  // the context block aloud. This is the same technique Google AI
  // Studio exposes as the "Sample Context" field in the TTS playground.
  const ctxBlock = carryOverContext?.trim();
  const contextLines = ctxBlock
    ? [
        "",
        "## PREVIOUS CONTEXT (READ ONLY FOR PROSODY CALIBRATION — DO NOT SPEAK THIS BLOCK)",
        "The text below is what the speaker JUST FINISHED reading in the same continuous take.",
        "Use it ONLY to anchor your pace, pitch, and energy so this section continues seamlessly",
        "from the previous one. Skip ahead to the TRANSCRIPT marker and speak ONLY that.",
        "",
        ctxBlock,
      ]
    : [];

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
    ...contextLines,
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
  /** Caller's user id — propagated to api_call_logs for finops
   *  attribution. `null` is reserved for system pings; production
   *  callers should always pass a real id. (C-8-5 / C-9-7) */
  userId?: string | null;
  /** Caller's generation id — same rationale as userId. */
  generationId?: string | null;
  /** Caller's worker job id — same rationale as userId. */
  jobId?: string | null;
  /** Last 1-2 sentences of the PREVIOUS chunk in the same master read.
   *  Included in the prompt as a "Sample Context" calibration block (NOT
   *  spoken). Gives Gemini a prosody anchor so chunk N+1 matches chunk N
   *  on pace/pitch/energy — fixes the "two different voices" seam between
   *  chunks. Only relevant for chunked master audio; safe to omit for
   *  single-call scenes. */
  carryOverContext?: string | null;
  /** Hard-timeout AbortSignal threaded from the worker's per-job
   *  AbortController. When the handler timeout fires, in-flight Gemini
   *  fetch() calls reject with AbortError and the retry loop exits
   *  immediately instead of grinding through the remaining attempts. */
  signal?: AbortSignal;
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

  const text = stripBadControlChars((opts.text || "").trim());
  if (text.length < 2) return { pcm: null, error: "Gemini Flash TTS: empty text" };

  const apiKeys = opts.apiKeys.filter(Boolean);
  if (apiKeys.length === 0) return { pcm: null, error: "Gemini Flash TTS: no GOOGLE_TTS_API_KEY configured" };

  const promptText = buildDirectivePrompt(
    text,
    opts.directives,
    opts.carryOverContext ? stripBadControlChars(opts.carryOverContext) : opts.carryOverContext,
  );

  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      // Tone clamps — keep prosody from drifting into dramatic /
      // theatrical territory even when the transcript leans heavy.
      // temperature 0.7 + topP 0.8 narrows the prosody sampling
      // distribution so the model picks more typical reads (steady,
      // documentary-ish) without going fully robotic.
      temperature: 0.65,
      topP: 0.8,
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
    // ── OpenRouter primary path ──────────────────────────────────
    // Single-shot through OpenRouter before touching the native
    // key-rotation loop. Avoids the per-Google-Cloud-project access
    // denials that took the native path offline on 2026-05-25.
    const orResult = await _openRouterTTSSynthesize(promptText, voiceName, opts.signal);
    if (orResult.pcm) {
      console.log(
        `[GeminiFlashTTS] Chunk for scene-id ${opts.sceneNumber} ✅ via OpenRouter (${orResult.pcm.length} PCM bytes)`,
      );
      return { pcm: orResult.pcm };
    }
    console.warn(
      `[GeminiFlashTTS] Scene ${opts.sceneNumber} OpenRouter primary failed (${orResult.error}) — falling back to native key rotation`,
    );

    const MAX_ATTEMPTS = 5;
    let lastError = "";
    const startOffset = Math.floor(Math.random() * apiKeys.length);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (opts.signal?.aborted) {
        return { pcm: null, error: "Gemini Flash TTS aborted by hard-timeout signal" };
      }
      const apiKey = apiKeys[(startOffset + attempt - 1) % apiKeys.length];
      const { signal: combinedSignal, cleanup: cleanupSignal } =
        combineSignalWithTimeout(opts.signal, PER_FETCH_TIMEOUT_MS);
      try {
        let res: Response;
        try {
          res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: combinedSignal },
          );
        } finally {
          cleanupSignal();
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          // Bumped 200 → 800 char preview so Google's nested error details
          // (`details: [{ "@type": "...BadRequest", ...}]`) survive — these
          // are what tell us the *actual* reason for INVALID_ARGUMENT.
          lastError = `Gemini Flash TTS ${res.status}: ${errText.substring(0, 800)}`;
          console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber} attempt ${attempt}/${MAX_ATTEMPTS} ${lastError}`);
          // On 400, also dump diagnostic info about the chunk so we can
          // identify what content triggered the malformed-request error
          // (control chars, length boundary, odd unicode, etc.).
          if (res.status === 400) {
            const t = text;
            const ctl = (t.match(/[ --]/g) ?? []).length;
            const preview = (s: string) => s.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").slice(0, 100);
            console.warn(
              `[GeminiFlashTTS] 400 diag: text.length=${t.length}, control_chars=${ctl}, ` +
              `prompt.length=${promptText.length}, voice=${voiceName}, ` +
              `head="${preview(t.slice(0, 100))}", tail="${preview(t.slice(-100))}"`,
            );
          }
          // Non-retriable client errors — bad key (401), banned project
          // (403 PERMISSION_DENIED) or malformed request (400). Retrying
          // burns the per-job budget for nothing; surface immediately so
          // the caller can attribute the failure correctly. Mirrors the
          // URL-returning path's behavior (search "Non-retriable client
          // errors" below).
          if (res.status === 400 || res.status === 401 || res.status === 403) {
            return { pcm: null, error: lastError };
          }
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
        // AbortError can come from EITHER the worker's outer hard-timeout
        // OR the per-fetch 60s cap above. Distinguish by checking the
        // outer signal: if it's aborted we exit entirely; otherwise it
        // was just a stalled call and we move to the next API key.
        if (err instanceof Error && err.name === "AbortError") {
          if (opts.signal?.aborted) {
            return { pcm: null, error: "Gemini Flash TTS aborted by hard-timeout signal" };
          }
          lastError = `Gemini Flash TTS attempt ${attempt} timed out after ${PER_FETCH_TIMEOUT_MS / 1000}s`;
          console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber}: ${lastError}`);
          if (attempt < MAX_ATTEMPTS) { await sleep(1000); continue; }
          break;
        }
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
    /** Soft cap per chunk in characters. ~2700 → ~3:00 of audio per chunk
     *  at the 165 WPM target set in the directive. Verified ceiling:
     *  Google AI Studio playground renders 2:40 with this model
     *  (gemini-3.1-flash-tts-preview) in one call cleanly, and the model
     *  card claims up to ~3 min stays in the drift-free zone. Result:
     *  anything ≤3:00 stays as ONE chunk (no cross-chunk seams at all),
     *  and longer masters split into evenly-balanced chunks (5min → 2
     *  chunks ~2:30 each, 6min → 2 chunks ~3:00 each, not 1 long + 1
     *  short). The previous-context carry-over (`carryOverContext`
     *  per-chunk) keeps prosody consistent across the splits when
     *  chunking IS needed. */
    targetChunkChars?: number;
    /** Max parallel chunks in flight at once. 3 is conservative for
     *  Gemini Tier 1 TPM (audio output tokens add up fast). */
    parallelism?: number;
  },
): Promise<{ url: string | null; durationSeconds?: number; provider?: string; error?: string }> {
  // ~30s of audio per chunk at the 165 WPM pacing anchor. Smaller
  // chunks (vs. the previous 2700-char / ~3-min slabs) let each
  // independent generateContent call stay on the same prosody profile
  // for its full duration — fewer mid-chunk drifts into theatrical
  // delivery on heavy topics. The carry-over context block between
  // chunks keeps prosody consistent across the joins.
  const targetChars = opts.targetChunkChars ?? 500;
  const parallelism = opts.parallelism ?? 3;
  const chunks = chunkBySentences(opts.masterText, targetChars);

  // Pre-compute carry-over context per chunk: each chunk (except the
  // first) gets the last 1-2 sentences (capped at 240 chars) of the
  // PREVIOUS chunk's source text as a "Sample Context" calibration
  // anchor — same technique Google AI Studio's TTS playground uses.
  // The source text is deterministic from the master, so we can compute
  // these up-front and keep the chunks rendering in parallel without
  // waiting for the previous chunk's audio.
  const carryOver: (string | null)[] = chunks.map((_, idx) => {
    if (idx === 0) return null;
    const prev = chunks[idx - 1];
    const match = prev.match(/(?:[^.!?]+[.!?]+\s*){1,2}$/);
    const tail = (match?.[0] ?? prev.slice(-240)).trim();
    return tail.length > 240 ? tail.slice(-240).trim() : tail;
  });

  console.log(`[GeminiFlashTTS] Master: chunking ${opts.masterText.length} chars into ${chunks.length} chunk(s) of ~${targetChars} chars each (carry-over context on chunks ${carryOver.filter(Boolean).length})`);

  // Run with concurrency cap. Order matters — we'll concat in chunk
  // order — so we don't fire all in a Promise.all; instead, claim
  // slots and write into a fixed-position result array.
  const pcmResults = new Array<Uint8Array | null>(chunks.length).fill(null);
  let nextIdx = 0;
  let firstError: string | null = null;

  // Runaway-output guard: Gemini TTS occasionally pads chunks with
  // silence or hallucinated extensions, producing audio MUCH longer
  // than the input text warrants. The merged master then ends up with
  // dead air or extra speech glued in at chunk boundaries.
  //
  // We compute the expected chunk duration from char count at the
  // 165 WPM pacing anchor and reject anything more than `RUNAWAY_MULTIPLIER`
  // times that. A 500-char chunk expects ~36s of audio; 2× allows for
  // some natural prosody slack (slow phrases, emphasis) up to ~72s
  // while still catching the worst padding cases. We previously ran
  // this at 3× but legitimate-looking padded chunks (~2.4× expected)
  // still leaked through and pushed master totals 35-40% over budget;
  // 2× is the sweet spot in observed real-world ranges.
  const BYTES_PER_SECOND = GEMINI_PCM_SAMPLE_RATE * 2; // 24kHz × 16-bit mono = 48,000
  const WORDS_PER_MINUTE = 165;
  const AVG_CHARS_PER_WORD = 5;
  const RUNAWAY_MULTIPLIER = 2; // chunk audio >2× expected → drop & retry
  function expectedSecondsForChars(charCount: number): number {
    return (charCount / AVG_CHARS_PER_WORD / WORDS_PER_MINUTE) * 60;
  }

  async function generateChunkWithRunawayGuard(
    chunkIdx: number,
    chunkText: string,
    carryOverText: string | null,
  ): Promise<{ pcm: Uint8Array | null; error?: string }> {
    const expectedSec = expectedSecondsForChars(chunkText.length);
    const maxAcceptableBytes = Math.ceil(expectedSec * RUNAWAY_MULTIPLIER * BYTES_PER_SECOND);
    const MAX_RUNAWAY_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RUNAWAY_RETRIES; attempt++) {
      const result = await generateGeminiFlashTTSPCM({
        ...opts,
        text: chunkText,
        sceneNumber: -1 - chunkIdx,
        carryOverContext: carryOverText,
      });
      if (!result.pcm) return result;

      // Sanity check on output length. < ~80% expected isn't worth
      // retrying (model may have skipped padding) — only the runaway
      // upper bound is the real failure mode here.
      if (result.pcm.length <= maxAcceptableBytes) {
        if (attempt > 0) {
          console.log(`[GeminiFlashTTS] Chunk ${chunkIdx + 1} recovered on attempt ${attempt + 1} (${result.pcm.length} bytes vs cap ${maxAcceptableBytes})`);
        }
        return result;
      }

      const actualSec = result.pcm.length / BYTES_PER_SECOND;
      console.warn(
        `[GeminiFlashTTS] Chunk ${chunkIdx + 1} runaway output: ${result.pcm.length} bytes ` +
        `(~${actualSec.toFixed(0)}s) for ${chunkText.length}-char input ` +
        `(expected ~${expectedSec.toFixed(0)}s; cap ~${(expectedSec * RUNAWAY_MULTIPLIER).toFixed(0)}s). ` +
        `${attempt < MAX_RUNAWAY_RETRIES ? `Retrying (${attempt + 1}/${MAX_RUNAWAY_RETRIES})` : "Out of retries"}.`,
      );
    }
    return {
      pcm: null,
      error: `Chunk ${chunkIdx + 1} kept producing runaway output (>${RUNAWAY_MULTIPLIER}× expected duration) across ${MAX_RUNAWAY_RETRIES + 1} attempts`,
    };
  }

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= chunks.length) return;
      if (firstError) return; // short-circuit if a sibling already failed
      // Hard-timeout escape hatch: if the per-job AbortController fired
      // while we were queued behind the 6-slot Gemini semaphore, exit
      // before claiming a slot.
      if (opts.signal?.aborted) {
        if (!firstError) firstError = `Chunk ${idx + 1}/${chunks.length} aborted by hard-timeout signal`;
        return;
      }

      const result = await generateChunkWithRunawayGuard(idx, chunks[idx], carryOver[idx]);

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

  const text = stripBadControlChars((opts.text || "").trim());
  if (text.length < 2) return { url: null, error: "Gemini Flash TTS: empty text" };

  const apiKeys = opts.apiKeys.filter(Boolean);
  if (apiKeys.length === 0) return { url: null, error: "Gemini Flash TTS: no GOOGLE_TTS_API_KEY configured" };

  const promptText = buildDirectivePrompt(
    text,
    opts.directives,
    opts.carryOverContext ? stripBadControlChars(opts.carryOverContext) : opts.carryOverContext,
  );

  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      // Tone clamps — keep prosody from drifting into dramatic /
      // theatrical territory even when the transcript leans heavy.
      // temperature 0.7 + topP 0.8 narrows the prosody sampling
      // distribution so the model picks more typical reads (steady,
      // documentary-ish) without going fully robotic.
      temperature: 0.65,
      topP: 0.8,
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
    // ── OpenRouter primary path ──────────────────────────────────
    // Single-shot through OpenRouter before touching the native
    // key-rotation loop. Avoids the per-Google-Cloud-project access
    // denials that took the native path offline on 2026-05-25.
    // On success: same WAV wrap + upload + log flow as the native
    // path, just attributed to "openrouter" in api_call_logs.
    const orResult = await _openRouterTTSSynthesize(promptText, voiceName, opts.signal);
    if (orResult.pcm) {
      const wav = pcmToWav(orResult.pcm, GEMINI_PCM_SAMPLE_RATE, 1, 16);
      const url = await uploadAudio(wav, "audio/wav", opts.projectId, opts.sceneNumber);
      const durationSeconds = Math.max(1, orResult.pcm.length / (GEMINI_PCM_SAMPLE_RATE * 2));
      console.log(
        `[GeminiFlashTTS] Scene ${opts.sceneNumber} ✅ via OpenRouter voice=${voiceName} (${orResult.pcm.length} PCM bytes, ~${durationSeconds.toFixed(1)}s)`,
      );
      writeApiLog({
        userId: opts.userId ?? null,
        generationId: opts.generationId ?? null,
        jobId: opts.jobId ?? null,
        provider: "openrouter", model: `openrouter:${MODEL}`,
        status: "success", totalDurationMs: Date.now() - startTime,
        cost: ttsSecondsCostUsd("gemini_flash_tts", durationSeconds),
        error: undefined,
      }).catch((err) => { console.warn('[GeminiFlashTTS] background log failed:', (err as Error).message); });
      return {
        url, durationSeconds,
        provider: `OpenRouter Gemini 3.1 Flash TTS (${voiceName})`,
      };
    }
    console.warn(
      `[GeminiFlashTTS] Scene ${opts.sceneNumber} OpenRouter primary failed (${orResult.error}) — falling back to native key rotation`,
    );

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
      if (opts.signal?.aborted) {
        return { url: null, error: "Gemini Flash TTS aborted by hard-timeout signal" };
      }
      const apiKey = apiKeys[(startOffset + attempt - 1) % apiKeys.length];
      const { signal: combinedSignal, cleanup: cleanupSignal } =
        combineSignalWithTimeout(opts.signal, PER_FETCH_TIMEOUT_MS);
      try {
        let res: Response;
        try {
          res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: combinedSignal,
            },
          );
        } finally {
          cleanupSignal();
        }

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
        // Real cost = $0.001/min × actual synthesized audio seconds.
        // We bill by output duration, not text length — matches Google's
        // billing model and lets dashboards reconcile to the invoice.
        writeApiLog({
          userId: opts.userId ?? null,
          generationId: opts.generationId ?? null,
          jobId: opts.jobId ?? null,
          provider: "google_tts", model: MODEL,
          status: "success", totalDurationMs: Date.now() - startTime,
          cost: ttsSecondsCostUsd("gemini_flash_tts", durationSeconds),
          error: undefined,
        }).catch((err) => { console.warn('[GeminiFlashTTS] background log failed:', (err as Error).message); });

        return {
          url,
          durationSeconds,
          provider: `Gemini 3.1 Flash TTS (${voiceName})`,
        };
      } catch (err) {
        // AbortError can come from EITHER the worker's outer hard-timeout
        // OR the per-fetch 60s cap above. Distinguish by checking the
        // outer signal: if it's aborted we exit entirely; otherwise it
        // was just a stalled call and we move to the next API key.
        if (err instanceof Error && err.name === "AbortError") {
          if (opts.signal?.aborted) {
            return { url: null, error: "Gemini Flash TTS aborted by hard-timeout signal" };
          }
          lastError = `Gemini Flash TTS attempt ${attempt} timed out after ${PER_FETCH_TIMEOUT_MS / 1000}s`;
          console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber}: ${lastError}`);
          if (attempt < MAX_ATTEMPTS) { await sleep(1000); continue; }
          break;
        }
        lastError = (err as Error).message;
        console.warn(`[GeminiFlashTTS] Scene ${opts.sceneNumber} attempt ${attempt} threw: ${lastError}`);
        if (attempt < MAX_ATTEMPTS) await sleep(1500 * attempt);
      }
    }

    // Failed call — no audio synthesized, so cost is $0 (Gemini Flash
    // doesn't bill failed responses). Attribution still required so the
    // failure shows up in per-user error dashboards.
    writeApiLog({
      userId: opts.userId ?? null,
      generationId: opts.generationId ?? null,
      jobId: opts.jobId ?? null,
      provider: "google_tts", model: MODEL,
      status: "error", totalDurationMs: Date.now() - startTime,
      cost: 0, error: lastError,
    }).catch((err) => { console.warn('[GeminiFlashTTS] background log failed:', (err as Error).message); });
    return { url: null, error: lastError || `Gemini Flash TTS failed after ${MAX_ATTEMPTS} attempts` };
  } finally {
    releaseGeminiFlashSlot();
  }
}
