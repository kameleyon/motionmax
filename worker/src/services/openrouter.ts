/**
 * OpenRouter LLM integration for the Node.js worker.
 *
 * Re-exports the three prompt builders (each in its own module to stay
 * under 300 lines) and provides callOpenRouterLLM — the raw API caller
 * with NO timeout (that's the whole point of the worker).
 */

import { writeApiLog } from "../lib/logger.js";

/**
 * Parse an HTTP Retry-After header value. RFC 9110 §10.2.3 says it's
 * EITHER a non-negative integer count of seconds OR an HTTP-date.
 * Returns the wait duration in ms, clamped to [0, capMs]. Returns
 * `null` if the header is missing/garbled — caller falls back to its
 * own backoff schedule.
 *
 * Capped because some upstreams return Retry-After: 3600 on a transient
 * 429 — holding a worker job for an hour blows the per-job timeout and
 * tanks the queue. 60s is the audit-recommended cap (C-8-2).
 */
export function parseRetryAfter(raw: string | null | undefined, capMs = 60_000): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Form 1: integer seconds.
  if (/^\d+$/.test(trimmed)) {
    const secs = parseInt(trimmed, 10);
    if (!Number.isFinite(secs) || secs < 0) return null;
    return Math.min(capMs, secs * 1000);
  }
  // Form 2: HTTP-date. Date.parse accepts RFC 1123 / RFC 850 / asctime
  // forms — close enough for our purposes; if upstream sends something
  // weirder we just fall back to local backoff.
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return null;
  const deltaMs = t - Date.now();
  if (deltaMs <= 0) return 0;
  return Math.min(capMs, deltaMs);
}

// ── OpenRouter concurrency limiter ─────────────────────────────────
// Caps simultaneous outbound OpenRouter calls process-wide. Without
// this, 3 generate_video jobs claimed in parallel each fire their own
// OpenRouter request, slamming the per-key rate limiter — verified
// 2026-05-09 09:00 UTC: a 3-fire autopost batch ("8 Of Clubs", "FIFA",
// "1958 Pelé") all hit the parent's 12-min coordinator-timeout
// simultaneously because OpenRouter throttled them into the multi-
// minute hang range, then the Hypereal fallback couldn't finish
// before parent gave up (chain budget = 7 min OR + 7 min Hypereal
// = 14 min worst case, > 12 min parent budget).
//
// Cap=2 lets one big batch keep two requests flowing without piling
// onto the rate limiter. The limiter is local to the worker process
// — separate worker instances aren't coordinated, but in production
// there's typically one worker so single-process coverage is enough.
// Mirrors the acquireHypereal/releaseHypereal pattern in
// imageGenerator.ts:92-110.

const OPENROUTER_MAX_CONCURRENT = 2;
let _openrouterActive = 0;
const _openrouterQueue: Array<() => void> = [];

export function acquireOpenRouter(): Promise<void> {
  if (_openrouterActive < OPENROUTER_MAX_CONCURRENT) {
    _openrouterActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    _openrouterQueue.push(() => { _openrouterActive++; resolve(); });
  });
}

export function releaseOpenRouter(): void {
  _openrouterActive--;
  const next = _openrouterQueue.shift();
  if (next) next();
}

// ── Re-exports ─────────────────────────────────────────────────────

export { buildDoc2VideoPrompt } from "./buildDoc2Video.js";
export type { Doc2VideoParams, PromptResult } from "./buildDoc2Video.js";

export { buildSmartFlowPrompt } from "./buildSmartFlow.js";
export type { SmartFlowParams } from "./buildSmartFlow.js";

export { buildCinematicPrompt } from "./buildCinematic.js";
export type { CinematicParams } from "./buildCinematic.js";

// ── callOpenRouterLLM ──────────────────────────────────────────────

/**
 * Call the OpenRouter chat-completions API.
 *
 * @param prompt  - `{ system, user }` strings produced by a builder.
 * @param options - `{ maxTokens, model? }`.  Defaults to claude-sonnet-4.
 * @returns The raw text content from the LLM response.
 *
 * There is intentionally NO AbortController / timeout here — the worker
 * runs on Render with no execution-time cap, unlike Supabase Edge Functions.
 */
export interface OpenRouterLLMOptions {
  maxTokens: number;
  model?: string;
  forceJson?: boolean;
  temperature?: number;
  /** Enable OpenRouter's web search plugin (Exa-backed). Adds
   *  `plugins: [{ id: "web" }]` to the request — works on any model. */
  enableWebSearch?: boolean;
  /** Optional public image URLs to fold into the user message as
   *  OpenAI-style multimodal `image_url` parts. When omitted, the user
   *  message is sent as a plain string (existing behavior). */
  imageUrls?: string[];
}

export async function callOpenRouterLLM(
  prompt: { system: string; user: string },
  options: OpenRouterLLMOptions,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  // Wait for an OpenRouter slot before starting the request. Time spent
  // here doesn't count against the per-call timeout because the
  // AbortController is set up after we acquire — that's intentional, so
  // a queued caller doesn't time itself out before its turn.
  const queueStart = Date.now();
  await acquireOpenRouter();
  const queueWaitMs = Date.now() - queueStart;
  if (queueWaitMs > 1000) {
    console.log(`[OpenRouter] Waited ${Math.round(queueWaitMs / 1000)}s in concurrency queue (cap ${OPENROUTER_MAX_CONCURRENT})`);
  }

  try {
    return await _callOpenRouterLLMInner(prompt, options, apiKey);
  } finally {
    releaseOpenRouter();
  }
}

async function _callOpenRouterLLMInner(
  prompt: { system: string; user: string },
  options: OpenRouterLLMOptions,
  apiKey: string,
): Promise<string> {
  const model = options.model || "anthropic/claude-sonnet-4.6";
  const temperature = options.temperature ?? 0.7;
  const startTime = Date.now();
  const hasImages = (options.imageUrls?.length ?? 0) > 0;
  console.log(`[OpenRouter] Calling ${model} (maxTokens=${options.maxTokens}, temp=${temperature}, forceJson=${!!options.forceJson}, webSearch=${!!options.enableWebSearch}, images=${options.imageUrls?.length ?? 0})`);

  // When imageUrls are present, the user message becomes a multimodal
  // content array (OpenAI-style). Otherwise we keep the plain-string
  // form so existing callers' behavior is unchanged.
  const userContent: unknown = hasImages
    ? [
        { type: "text", text: prompt.user },
        ...options.imageUrls!.slice(0, 8).map((url) => ({
          type: "image_url",
          image_url: { url },
        })),
      ]
    : prompt.user;

  const requestBody: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens,
    temperature,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: userContent },
    ],
  };

  // Force JSON output at the API level to prevent malformed responses
  if (options.forceJson) {
    requestBody.response_format = { type: "json_object" };
  }

  // OpenRouter's `web` plugin grounds the call on Exa-powered web
  // search. Works on any model — they prepend retrieved snippets to the
  // conversation as system context. Use this when you'd otherwise reach
  // for Gemini's native `googleSearch` tool.
  if (options.enableWebSearch) {
    requestBody.plugins = [{ id: "web" }];
  }

  // Scale timeout with token count: 5 min base + 1 min per 2000 tokens above 4000
  const baseTimeoutMs = 5 * 60 * 1000;
  const extraTokens = Math.max(0, options.maxTokens - 4000);
  const extraTimeoutMs = Math.ceil(extraTokens / 2000) * 60 * 1000;
  const totalTimeoutMs = baseTimeoutMs + extraTimeoutMs;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), totalTimeoutMs);

  if (totalTimeoutMs > baseTimeoutMs) {
    console.log(`[OpenRouter] Extended timeout: ${Math.round(totalTimeoutMs / 1000)}s (maxTokens=${options.maxTokens})`);
  }

  // C-8-2 / Crash CRASH-003: honour 429 Retry-After. OpenRouter's
  // limiter is per-key + bursty; the 2026-05-09 incident was caused by
  // this code ignoring Retry-After and slamming the API on its local
  // backoff schedule, prolonging the rate-limited state. Now: on 429,
  // we read Retry-After (seconds or HTTP-date), sleep that long (capped
  // at 60s so a worker doesn't hang on a misbehaving header), and retry
  // up to MAX_429_RETRIES times within this single call. Past that, we
  // surface the 429 to the caller's withTransientRetry — the regex
  // classifier already maps "OpenRouter API error 429" → transient
  // (TRANSIENT_PATTERNS in retryClassifier.ts).
  const MAX_429_RETRIES = 3;
  const RETRY_AFTER_CAP_MS = 60_000;
  let res: Response | undefined;
  let consecutive429 = 0;
  fetchLoop:
  for (let attempt = 1; attempt <= 2 + MAX_429_RETRIES; attempt++) {
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://motionmax.io",
          "X-Title": "MotionMax",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      // 429 → respect Retry-After then retry within this call.
      if (res.status === 429 && consecutive429 < MAX_429_RETRIES) {
        consecutive429++;
        const headerVal = res.headers.get("retry-after");
        const parsed = parseRetryAfter(headerVal, RETRY_AFTER_CAP_MS);
        // If header absent/garbled: fall back to exponential 2s → 4s → 8s
        // (the same shape the dispatcher's withTransientRetry uses).
        const waitMs = parsed !== null
          ? parsed
          : Math.min(RETRY_AFTER_CAP_MS, 2_000 * Math.pow(2, consecutive429 - 1));
        console.warn(
          `[OpenRouter] 429 rate-limited (streak=${consecutive429}/${MAX_429_RETRIES}) — ` +
          `Retry-After=${headerVal ?? "<none>"}, sleeping ${Math.round(waitMs / 1000)}s before retry`,
        );
        // Drain body so the connection can be reused.
        await res.text().catch(() => {});
        await new Promise((r) => setTimeout(r, waitMs));
        continue fetchLoop;
      }
      break; // success or non-429 error to be handled below
    } catch (err: any) {
      if (err.name === "AbortError") {
        clearTimeout(timeoutId);
        throw new Error(`OpenRouter request timed out after ${Math.round(totalTimeoutMs / 1000)}s (model: ${model}, maxTokens: ${options.maxTokens})`);
      }
      if (attempt < 2 + MAX_429_RETRIES) {
        console.warn(`[OpenRouter] Fetch failed (attempt ${attempt}), retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      clearTimeout(timeoutId);
      throw err;
    }
  }
  clearTimeout(timeoutId);
  if (!res) throw new Error("OpenRouter fetch failed after retries");

  if (!res.ok) {
    const body = await res.text();
    // Surface 429 with explicit prefix so withTransientRetry / the
    // isTransientError classifier picks it up unambiguously even
    // through wrapped error chains. The classifier already matches
    // /\b429\b/ but a stable string prefix simplifies the operator
    // forensics in Sentry breadcrumbs.
    const tag = res.status === 429 ? "OpenRouter rate-limited (429) after retries" : `OpenRouter API error ${res.status}`;
    const err = new Error(`${tag}: ${body}`);
    writeApiLog({ userId: null, generationId: null, jobId: null, provider: "openrouter", model, status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch((err) => { console.warn('[OpenRouter] background log failed:', (err as Error).message); });
    throw err;
  }

  const data = (await res.json()) as any;
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    const err = new Error("OpenRouter returned empty content");
    writeApiLog({ userId: null, generationId: null, jobId: null, provider: "openrouter", model, status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch((err) => { console.warn('[OpenRouter] background log failed:', (err as Error).message); });
    throw err;
  }

  console.log(`[OpenRouter] Response received (${text.length} chars)`);
  writeApiLog({ userId: null, generationId: null, jobId: null, provider: "openrouter", model, status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[OpenRouter] background log failed:', (err as Error).message); });
  return text;
}

// ── callHyperealLLM (Gemini 3.1 Pro — primary) ──────────────────────

/**
 * Call Hypereal chat API with Gemini 3.1 Pro.
 * Same interface as callOpenRouterLLM for easy swap.
 */
export async function callHyperealLLM(
  prompt: { system: string; user: string },
  options: { maxTokens: number; forceJson?: boolean; temperature?: number },
): Promise<string> {
  const apiKey = process.env.HYPEREAL_API_KEY;
  if (!apiKey) throw new Error("HYPEREAL_API_KEY is not set");

  // Lower temperature for JSON output to reduce creative wandering
  const temperature = options.forceJson ? Math.min(options.temperature ?? 0.7, 0.4) : (options.temperature ?? 0.7);
  const startTime = Date.now();
  console.log(`[Hypereal] Calling gemini-3.1-fast (maxTokens=${options.maxTokens}, temp=${temperature}, forceJson=${!!options.forceJson})`);

  // Hypereal API does NOT support response_format -- enforce JSON via:
  // 1. System prompt prefix (seen first)
  // 2. User prompt suffix (recency bias — models pay attention to the last instruction)
  // 3. Assistant pre-fill starting with "{" (forces model to continue in JSON)
  const JSON_SYSTEM_PREFIX = `YOU ARE A JSON GENERATOR. Your ENTIRE response must be a single valid JSON object. No thinking, no explanation, no markdown, no \`\`\`json blocks, no text before or after. Start your response with { and end with }. Do NOT use <think> tags. Do NOT add any validation summary, word count, scene-by-scene check, or commentary AFTER the closing }. The response ENDS with the closing } — anything after that breaks the parser.`;
  const JSON_USER_SUFFIX = `\n\nREMINDER: Return ONLY raw JSON. No markdown, no explanation, no \`\`\`json fences. Start with { and end with }. ABSOLUTELY NO TEXT AFTER THE CLOSING }: no "Validation:", no "Count: word(1) word(2)...", no "Scene N:" recap, no format-debate commentary. Stop generating the moment you write the final }.`;

  const systemPrompt = options.forceJson
    ? `${JSON_SYSTEM_PREFIX}\n\n${prompt.system}`
    : prompt.system;

  const userPrompt = options.forceJson
    ? `${prompt.user}${JSON_USER_SUFFIX}`
    : prompt.user;

  const messages: Array<Record<string, string>> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Assistant pre-fill: prime the model to start outputting JSON immediately.
  // Many OpenAI-compatible APIs (including Hypereal) support this.
  if (options.forceJson) {
    messages.push({ role: "assistant", content: "{" });
  }

  const requestBody: Record<string, unknown> = {
    model: "gemini-3.1-fast",
    max_tokens: options.maxTokens,
    temperature,
    stream: false,
    messages,
  };
  // NOTE: response_format NOT sent -- Hypereal API does not support it

  // Generous timeout: 5 min base + scaling with token count
  const baseTimeoutMs = 5 * 60 * 1000;
  const extraTokens = Math.max(0, options.maxTokens - 4000);
  const extraTimeoutMs = Math.ceil(extraTokens / 2000) * 60 * 1000;
  const totalTimeoutMs = baseTimeoutMs + extraTimeoutMs;

  const res = await fetch("https://api.hypereal.cloud/v1/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(totalTimeoutMs),
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Hypereal API error ${res.status}: ${body.substring(0, 300)}`);
    writeApiLog({ userId: null, generationId: null, jobId: null, provider: "hypereal", model: "gemini-3.1-fast", status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch((err) => { console.warn('[OpenRouter] background log failed:', (err as Error).message); });
    throw err;
  }

  const data = (await res.json()) as any;
  let text = data.choices?.[0]?.message?.content;
  if (!text) {
    const err = new Error("Hypereal returned empty content");
    writeApiLog({ userId: null, generationId: null, jobId: null, provider: "hypereal", model: "gemini-3.1-fast", status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch((err) => { console.warn('[OpenRouter] background log failed:', (err as Error).message); });
    throw err;
  }

  // If we used assistant pre-fill, the model's response won't include the
  // leading "{" we sent — prepend it back so the JSON is complete.
  if (options.forceJson && !text.trimStart().startsWith("{")) {
    text = "{" + text;
  }

  // Fix double braces from assistant pre-fill echo — some APIs return the
  // pre-fill "{" as part of the completion, so the model's own "{" creates "{{".
  // Similarly handle doubled closing braces.
  if (options.forceJson) {
    text = text.replace(/^\s*\{\{/, "{");
    text = text.replace(/\}\}\s*$/, "}");
  }

  console.log(`[Hypereal] Response received (${text.length} chars, credits: ${data.creditsUsed ?? "?"})`);
  writeApiLog({ userId: null, generationId: null, jobId: null, provider: "hypereal", model: "gemini-3.1-fast", status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch((err) => { console.warn('[OpenRouter] background log failed:', (err as Error).message); });
  return text;
}

// ── callLLM (Hypereal primary, OpenRouter fallback) ──────────────────

/**
 * Call LLM through OpenRouter Claude Sonnet 4.6.
 *
 * Historical note: this function used to fall back to Hypereal's chat
 * surface (model `gemini-3.1-fast`) when OpenRouter failed. As of
 * 2026-05-12 Hypereal deprecated that model — calls now auto-route to
 * `claude-sonnet-4-6` which only accepts Anthropic-format requests on
 * `/v1/messages`, not the OpenAI-format `/v1/chat` endpoint our code
 * targets. The fallback's failure error ("Hypereal API error 400:
 * Model claude-sonnet-4-6 uses Anthropic format") was masking the
 * real OpenRouter error and confusing debugging.
 *
 * Per product direction (script generation should always be Claude
 * via OpenRouter), the Hypereal fallback is removed entirely. If
 * OpenRouter fails, the real OpenRouter error propagates so the
 * caller (and Sentry) sees the actual cause. callHyperealLLM is
 * preserved for any direct caller that still needs it, but it isn't
 * wired into the canonical script-gen path anymore.
 */
export async function callLLMWithFallback(
  prompt: { system: string; user: string },
  options: { maxTokens: number; forceJson?: boolean; temperature?: number },
): Promise<string> {
  return callOpenRouterLLM(prompt, options);
}

// ── Backward-compatible wrapper for legacy generateVideo handler ───

/** @deprecated Use buildDoc2VideoPrompt + callOpenRouterLLM instead. */
export async function extractScriptWithOpenRouter(
  prompt: string,
  style: string,
  targetDuration: number,
  _openRouterApiKey?: string,
): Promise<any> {
  const estimatedScenes = Math.max(1, Math.floor(targetDuration / 4));
  const systemPrompt = `You are an expert short-form video scriptwriter.
  Create an engaging, highly visual script tailored for a ${targetDuration} second video.
  Break the script down into exactly ${estimatedScenes} scenes.
  For each scene, provide a "visual_prompt" (what we see) and "narration" (what the voiceover says).
  The visual style is: ${style}. Return the result as valid JSON matching this schema:
  {
    "scenes": [
      { "number": 1, "visual_prompt": "...", "narration": "..." }
    ]
  }`;

  const raw = await callOpenRouterLLM(
    { system: systemPrompt, user: prompt },
    { maxTokens: 4000 },
  );
  return JSON.parse(raw);
}
