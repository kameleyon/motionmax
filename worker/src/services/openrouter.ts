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

  // Lower temperature for JSON output to reduce creative wandering
  const temperature = options.forceJson ? Math.min(options.temperature ?? 0.7, 0.4) : (options.temperature ?? 0.7);
  const startTime = Date.now();
  console.log(`[Hypereal] Calling gemini-3.1-pro (maxTokens=${options.maxTokens}, temp=${temperature}, forceJson=${!!options.forceJson})`);

  // Hypereal API does NOT support response_format -- enforce JSON via:
  // 1. System prompt prefix (seen first)
  // 2. User prompt suffix (recency bias — models pay attention to the last instruction)
  // 3. Assistant pre-fill starting with "{" (forces model to continue in JSON)
  const JSON_SYSTEM_PREFIX = `YOU ARE A JSON GENERATOR. Your ENTIRE response must be a single valid JSON object. No thinking, no explanation, no markdown, no \`\`\`json blocks, no text before or after. Start your response with { and end with }. Do NOT use <think> tags.`;
  const JSON_USER_SUFFIX = `\n\nREMINDER: Return ONLY raw JSON. No markdown, no explanation, no \`\`\`json fences. Start with { and end with }.`;

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
    model: "gemini-3.1-pro",
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
    writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: "gemini-3.1-pro", status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch(() => {});
    throw err;
  }

  const data = (await res.json()) as any;
  let text = data.choices?.[0]?.message?.content;
  if (!text) {
    const err = new Error("Hypereal returned empty content");
    writeApiLog({ userId: undefined, generationId: undefined, provider: "hypereal", model: "gemini-3.1-pro", status: "error", totalDurationMs: Date.now() - startTime, cost: 0, error: err.message }).catch(() => {});
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

      // Repair common Hypereal JSON malformations (runs AFTER <think> stripping)
      if (options.forceJson) {
        // Fix double braces from assistant pre-fill echo
        text = text.replace(/^\s*\{\{/, "{");
        text = text.replace(/\}\}\s*$/, "}");

        // Strip stray non-JSON lines (e.g. "Menu", markdown fences, model artifacts)
        text = text.split("\n").filter(line => {
          const t = line.trim();
          if (!t) return true; // keep blanks (harmless in JSON)
          // Drop bare words/phrases with no JSON punctuation
          if (/^[a-zA-Z_][a-zA-Z0-9_ ]*$/.test(t) && !/^(true|false|null)$/.test(t)) return false;
          // Drop markdown code fences
          if (t.startsWith("```")) return false;
          return true;
        }).join("\n");
      }

      // If forceJson requested, verify response actually contains parseable JSON
      if (options.forceJson) {
        const braceIdx = text.indexOf("{");
        const lastBrace = text.lastIndexOf("}");
        if (braceIdx === -1 || lastBrace <= braceIdx) {
          console.warn(`[LLM] Hypereal returned non-JSON (${text.length} chars, starts with: "${text.substring(0, 80)}") — falling back to OpenRouter`);
          throw new Error("Hypereal response is not JSON");
        }

        // Extract just the JSON object and strip trailing commas before closing brackets
        const extracted = text.slice(braceIdx, lastBrace + 1).replace(/,\s*([\]}])/g, "$1");

        // Quick sanity check: try to parse the JSON portion
        try {
          JSON.parse(extracted);
        } catch {
          console.warn(`[LLM] Hypereal returned malformed JSON (${text.length} chars, starts with: "${text.substring(0, 120)}") — falling back to OpenRouter`);
          throw new Error("Hypereal response is malformed JSON");
        }

        // Use the clean extracted JSON as the return value
        text = extracted;
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
