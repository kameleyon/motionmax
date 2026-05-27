/**
 * Native Google Gemini API wrapper with optional googleSearch grounding.
 *
 * Calls https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 * directly (NOT through OpenRouter or Hypereal) so we can enable the
 * `googleSearch` tool — that's the only way an LLM call can ground on
 * live web results during this conversation, instead of relying on
 * stale training data.
 *
 * Used by:
 *   - handleGenerateTopics  → fresh, on-topic title ideas
 *   - researchTopic         → factually current research brief before
 *                             cinematic / doc2video script generation
 *
 * Env required on the worker (Render):
 *   GOOGLE_TTS_API_KEY (or _2, _3) — same Google API key chain used
 *      by the TTS handler. Reads in priority order _3 → _2 → base,
 *      matching handleCinematicAudio.ts. The key needs the
 *      "Generative Language API" enabled in Google Cloud Console;
 *      if the existing keys are restricted to TTS-only, enable the
 *      additional API on the same project.
 *   GEMINI_MODEL — optional override, defaults to "gemini-3.1-pro-preview"
 *
 * Note on tool + JSON output: when googleSearch is enabled, Google's API
 * does NOT honor `responseMimeType: "application/json"` — search-grounded
 * responses come back as plain prose with citations. Callers that need
 * JSON should set `json: true` AND `enableSearch: false`, or post-parse
 * with the existing JSON-extraction helpers.
 */

const DEFAULT_MODEL = "gemini-3.1-pro-preview";

/** Stable, allowlist-free model used when the preview model returns
 *  403 PERMISSION_DENIED. Preview models (`*-preview`) require explicit
 *  project enrollment via Google AI Studio; when that hasn't happened
 *  on the project that owns our API key, every call gets denied even
 *  though the same key works for TTS audio. Falling back to a stable
 *  GA model self-heals the failure mode while we sort out enrollment. */
const FALLBACK_MODEL = "gemini-2.5-pro";

export interface GeminiCallOptions {
  /** System instruction (separate field on Google's API, not a message). */
  system?: string;
  /** User message text. */
  user: string;
  /** Optional image URLs to fold into the user message as parts. Public URLs only. */
  imageUrls?: string[];
  /** Enable Google Search grounding tool. Required for "search the web" use cases. */
  enableSearch?: boolean;
  /** Force JSON output. Ignored when enableSearch is true (Google's constraint). */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Override model id. Defaults to GEMINI_MODEL env or "gemini-3.1-pro-preview". */
  model?: string;
  /** Request abort timeout. Defaults to 60s. */
  timeoutMs?: number;
  /** Override the key resolution chain. Used by callGeminiWithKeyRotation
   *  to retry with each available Google key in turn after a 403. */
  apiKey?: string;
}

/** All available Google API keys, in priority order (newest first).
 *  Used by callGeminiWithKeyRotation to try each one when a 403
 *  arrives — different keys can map to different Google Cloud projects
 *  with different API enablement / allowlist state, so a key failing
 *  doesn't mean the whole chain is dead. */
function listGoogleApiKeys(): string[] {
  return [
    process.env.GOOGLE_TTS_API_KEY_3,
    process.env.GOOGLE_TTS_API_KEY_2,
    process.env.GOOGLE_TTS_API_KEY,
  ]
    .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    .map((k) => k.trim());
}

function resolveGoogleApiKey(): string {
  return listGoogleApiKeys()[0] ?? "";
}

export async function callGemini(opts: GeminiCallOptions): Promise<string> {
  // Caller can pin an explicit key (used by callGeminiWithKeyRotation
  // to walk through each available key) — otherwise we resolve the
  // highest-priority configured key from env.
  const apiKey = opts.apiKey?.trim() || resolveGoogleApiKey();
  if (!apiKey) {
    throw new Error("GOOGLE_TTS_API_KEY (or _2/_3) not configured on the worker");
  }

  const primaryModel = opts.model || process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const callerPinnedModel = !!opts.model;

  try {
    return await callGeminiWithModel(opts, apiKey, primaryModel);
  } catch (err) {
    // 403 PERMISSION_DENIED on the primary model usually means the
    // project hosting our API key isn't allowlisted for the preview
    // version we requested. Retry once with the stable fallback so
    // callers don't fail when the only thing wrong is preview access.
    // We skip the fallback if the caller explicitly pinned a model
    // (their choice wins) or if we're already on the fallback.
    const msg = err instanceof Error ? err.message : String(err);
    const is403PermissionDenied =
      msg.includes("Gemini API 403") && msg.includes("PERMISSION_DENIED");
    if (
      is403PermissionDenied &&
      !callerPinnedModel &&
      primaryModel !== FALLBACK_MODEL
    ) {
      console.warn(
        `[GeminiNative] ${primaryModel} returned 403 PERMISSION_DENIED — retrying with stable model ${FALLBACK_MODEL}`,
      );
      return await callGeminiWithModel(opts, apiKey, FALLBACK_MODEL);
    }
    throw err;
  }
}

/** Single-shot Gemini call for a given model id. Extracted out of
 *  callGemini so the 403 fallback can retry with a different model
 *  without duplicating the body-build / fetch / parse logic. */
async function callGeminiWithModel(
  opts: GeminiCallOptions,
  apiKey: string,
  model: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // Build user "parts" — text first, then any image URLs as fileData
  // refs (Gemini fetches public URLs server-side). For private storage,
  // we'd need to base64-encode bytes here; sticking to public URLs keeps
  // the wrapper simple.
  const userParts: Array<Record<string, unknown>> = [{ text: opts.user }];
  if (opts.imageUrls && opts.imageUrls.length > 0) {
    for (const u of opts.imageUrls.slice(0, 8)) {
      userParts.push({ fileData: { fileUri: u, mimeType: "image/jpeg" } });
    }
  }

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: userParts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 2048,
    },
  };

  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }

  if (opts.enableSearch) {
    body.tools = [{ googleSearch: {} }];
  } else if (opts.json) {
    (body.generationConfig as Record<string, unknown>).responseMimeType = "application/json";
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      promptFeedback?: { blockReason?: string };
    };

    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked prompt: ${data.promptFeedback.blockReason}`);
    }

    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) {
      throw new Error(`Gemini returned no content: ${JSON.stringify(data).slice(0, 300)}`);
    }
    const text = parts.map((p) => p.text || "").join("").trim();
    if (!text) {
      throw new Error(`Gemini returned empty text: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Like callGemini, but walks every configured Google API key
 *  (`GOOGLE_TTS_API_KEY_3 → _2 → base`) when a key returns 403.
 *  Different keys can belong to different Google Cloud projects with
 *  different API enablement / preview-allowlist state, so one key
 *  being denied access doesn't mean the whole chain is unusable.
 *
 *  Each key gets a full attempt — including the inner preview→stable
 *  model fallback that `callGemini` does on its own. Non-403 errors
 *  (network, timeout, JSON parse) bubble up immediately rather than
 *  burning the remaining keys on the same root cause.
 *
 *  Throws an aggregated error only when EVERY key returned a 403. */
export async function callGeminiWithKeyRotation(opts: GeminiCallOptions): Promise<string> {
  const keys = listGoogleApiKeys();
  if (keys.length === 0) {
    throw new Error("GOOGLE_TTS_API_KEY (or _2/_3) not configured on the worker");
  }
  const errors: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    try {
      return await callGemini({ ...opts, apiKey: keys[i] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is403 = msg.includes("Gemini API 403");
      if (!is403) throw err;
      errors.push(`key ${i + 1}/${keys.length}: ${msg.slice(0, 120)}`);
      console.warn(`[GeminiNative] Key ${i + 1}/${keys.length} returned 403 — trying next key`);
    }
  }
  throw new Error(`All ${keys.length} Google API keys returned 403. ${errors.join(" | ")}`);
}
