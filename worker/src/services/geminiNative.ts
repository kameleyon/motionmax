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
}

function resolveGoogleApiKey(): string {
  // Same priority chain as handleCinematicAudio.ts: try the newest /
  // highest-quota key first, fall through to older ones. All three
  // map to the same Google Cloud project; just slots so quota can be
  // rotated when one hits a daily cap.
  const candidates = [
    process.env.GOOGLE_TTS_API_KEY_3,
    process.env.GOOGLE_TTS_API_KEY_2,
    process.env.GOOGLE_TTS_API_KEY,
  ];
  for (const k of candidates) {
    if (k && k.trim().length > 0) return k.trim();
  }
  return "";
}

export async function callGemini(opts: GeminiCallOptions): Promise<string> {
  const apiKey = resolveGoogleApiKey();
  if (!apiKey) {
    throw new Error("GOOGLE_TTS_API_KEY (or _2/_3) not configured on the worker");
  }

  const model = opts.model || process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
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
