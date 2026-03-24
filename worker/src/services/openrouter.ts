/**
 * OpenRouter LLM integration for the Node.js worker.
 *
 * Re-exports the three prompt builders (each in its own module to stay
 * under 300 lines) and provides callOpenRouterLLM — the raw API caller
 * with NO timeout (that's the whole point of the worker).
 */

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

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as any;
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter returned empty content");

  console.log(`[OpenRouter] Response received (${text.length} chars)`);
  return text;
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
