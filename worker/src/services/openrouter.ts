/**
 * OpenRouter LLM integration for the Node.js worker.
 *
 * Re-exports the three prompt builders (each in its own module to stay
 * under 300 lines) and provides callOpenRouterLLM — the raw API caller
 * with NO timeout (that's the whole point of the worker).
 */

import { writeApiLog } from "../lib/logger.js";

// ── Re-exports ─────────────────────────────────────────────────────

export { buildDoc2VideoPrompt } from "./buildDoc2Video.js";
export type { Doc2VideoParams, PromptResult } from "./buildDoc2Video.js";

export { buildStorytellingPrompt } from "./buildStorytelling.js";
export type { StorytellingParams } from "./buildStorytelling.js";

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
export async function callOpenRouterLLM(
  prompt: { system: string; user: string },
  options: { maxTokens: number; model?: string; forceJson?: boolean; temperature?: number },
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const model = options.model || "anthropic/claude-sonnet-4.6";
  const temperature = options.temperature ?? 0.7;
  const startTime = Date.now();
  console.log(`[OpenRouter] Calling ${model} (maxTokens=${options.maxTokens}, temp=${temperature}, forceJson=${!!options.forceJson})`);

  const requestBody: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens,
    temperature,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
  };

  // Force JSON output at the API level to prevent malformed responses
  if (options.forceJson) {
    requestBody.response_format = { type: "json_object" };
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

  let res: Response | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      break; // success
    } catch (err: any) {
      if (err.name === "AbortError") {
        clearTimeout(timeoutId);
        throw new Error(`OpenRouter request timed out after ${Math.round(totalTimeoutMs / 1000)}s (model: ${model}, maxTokens: ${options.maxTokens})`);
      }
      if (attempt < 2) {
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
    const err = new Error(`OpenRouter API error ${res.status}: ${body}`);
    writeApiLog({ userId: undefined, generationId: undefined, provider: "openrouter", model, status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch(() => {});
    throw err;
  }

  const data = (await res.json()) as any;
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    const err = new Error("OpenRouter returned empty content");
    writeApiLog({ userId: undefined, generationId: undefined, provider: "openrouter", model, status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch(() => {});
    throw err;
  }

  console.log(`[OpenRouter] Response received (${text.length} chars)`);
  writeApiLog({ userId: undefined, generationId: undefined, provider: "openrouter", model, status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch(() => {});
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

  const temperature = options.temperature ?? 0.7;
  const startTime = Date.now();
  console.log(`[Hypereal] Calling gemini-3.1-pro (maxTokens=${options.maxTokens}, temp=${temperature}, forceJson=${!!options.forceJson})`);

  // Reinforce JSON output in the system prompt for Gemini (may not support response_format)
  const systemPrompt = options.forceJson
    ? prompt.system + "\n\nCRITICAL: Return ONLY valid JSON. No markdown, no ```json blocks, no explanation text. Start with { and end with }."
    : prompt.system;

  const requestBody: Record<string, unknown> = {
    model: "gemini-3.1-pro",
    max_tokens: options.maxTokens,
    temperature,
    stream: false,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt.user },
    ],
  };

  if (options.forceJson) {
    requestBody.response_format = { type: "json_object" };
  }

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
    writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: "gemini-3.1-pro", status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch(() => {});
    throw err;
  }

  const data = (await res.json()) as any;
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    const err = new Error("Hypereal returned empty content");
    writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: "gemini-3.1-pro", status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch(() => {});
    throw err;
  }

  console.log(`[Hypereal] Response received (${text.length} chars, credits: ${data.creditsUsed ?? "?"})`);
  writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: "gemini-3.1-pro", status: "success", totalDurationMs: Date.now() - startTime, cost: 0, error: undefined }).catch(() => {});
  return text;
}

// ── callLLM (Hypereal primary, OpenRouter fallback) ──────────────────

/**
 * Call LLM with automatic fallback: Hypereal/Gemini first, OpenRouter/Claude if that fails.
 */
export async function callLLMWithFallback(
  prompt: { system: string; user: string },
  options: { maxTokens: number; forceJson?: boolean; temperature?: number },
): Promise<string> {
  // Try Hypereal/Gemini first
  if (process.env.HYPEREAL_API_KEY) {
    try {
      let text = await callHyperealLLM(prompt, options);

      // Strip <think> tags (Gemini reasoning output)
      if (text.includes("<think>")) {
        text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
      }

      // If forceJson requested, verify response contains JSON
      if (options.forceJson && !text.includes("{")) {
        console.warn(`[LLM] Hypereal returned non-JSON (${text.length} chars, starts with: "${text.substring(0, 80)}") — falling back to OpenRouter`);
        throw new Error("Hypereal response is not JSON");
      }

      return text;
    } catch (err) {
      console.warn(`[LLM] Hypereal failed: ${(err as Error).message} — falling back to OpenRouter`);
    }
  }

  // Fallback to OpenRouter/Claude
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
