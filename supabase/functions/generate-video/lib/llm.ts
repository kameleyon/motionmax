/**
 * LLM call helpers (OpenRouter primary, single fallback).
 *
 * Contract:
 *   - callLLMWithFallback(prompt, options) — tries the primary model first
 *     (claude-sonnet-4 via OpenRouter), falls back to gemini-3.1-flash-lite
 *     on any error. Enforces a 140s gateway budget across attempts. If
 *     `jsonLabel` is set, runs the response through extractJsonFromLLMResponse
 *     and attaches `parsedContent` on the returned LLMCallResult.
 *   - callOpenRouter(apiKey, model, prompt, temperature, maxTokens, timeoutMs)
 *     — one-shot OpenRouter call with AbortController-backed timeout and
 *     verbose [LLM] console.log breadcrumbs. Throws on non-2xx, on empty
 *     content, and on AbortError (converted to a friendly timeout message).
 *   - extractJsonFromLLMResponse(raw, label) — robust JSON extractor that
 *     handles markdown fences, leading/trailing text, trailing commas, and
 *     truncated responses (auto-closes open braces/brackets).
 *
 * Module constants:
 *   PRIMARY_LLM_MODEL — claude-sonnet-4
 *   FALLBACK_MODEL    — gemini-3.1-flash-lite-preview
 *
 * Extracted 2026-05-10 per audit C-4-2 (Arch C-A3). Zero behavior change.
 */

// ============= LLM CALL TYPES =============
export interface LLMCallResult {
  content: string;
  parsedContent?: unknown;
  tokensUsed: number;
  provider: "openrouter";
  durationMs: number;
  model: string;
}

export const PRIMARY_LLM_MODEL = "anthropic/claude-sonnet-4";
export const FALLBACK_MODEL = "google/gemini-3.1-flash-lite-preview";

export function getLLMModelsToTry(primaryModel: string): string[] {
  return Array.from(new Set([primaryModel, FALLBACK_MODEL]));
}

// ============= ROBUST JSON EXTRACTION FROM LLM RESPONSES =============

/**
 * Extract and parse JSON from LLM response content.
 * Handles common LLM output issues:
 * - Markdown code fences (```json ... ```)
 * - Leading/trailing text around JSON
 * - Trailing commas before ] and }
 * - Truncated responses (attempts to close open structures)
 */
export function extractJsonFromLLMResponse(raw: string, label: string): any {
  if (!raw || typeof raw !== "string") {
    console.error(`[JSON_EXTRACT] ${label}: empty or non-string input`);
    throw new Error(`No content to parse for ${label}`);
  }

  console.log(`[JSON_EXTRACT] ${label}: starting parse`, {
    rawLength: raw.length,
    previewStart: raw.substring(0, 220),
    previewEnd: raw.substring(Math.max(0, raw.length - 220)),
  });

  let content = raw.trim();

  // Step 1: Strip markdown code fences
  if (content.startsWith("```")) {
    content = content
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
  }

  // Step 2: Extract JSON between first { and last }
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    console.error(`[JSON_EXTRACT] ${label}: no JSON object found. Raw (first 500 chars):`, content.substring(0, 500));
    throw new Error(`Failed to parse ${label}: no JSON object found in response`);
  }
  content = content.slice(firstBrace, lastBrace + 1);

  // Step 3: Fix trailing commas (common LLM issue)
  content = content.replace(/,\s*([\]}])/g, "$1");

  // Step 4: Try parsing
  try {
    const parsed = JSON.parse(content);
    console.log(`[JSON_EXTRACT] ${label}: parse success on first attempt`, {
      normalizedLength: content.length,
      topLevelKeys: getTopLevelKeys(parsed),
    });
    return parsed;
  } catch (firstError) {
    console.warn(`[JSON_EXTRACT] ${label}: first parse attempt failed:`, (firstError as Error).message);

    // Step 5: Attempt to fix truncated JSON by closing open structures
    let fixedContent = content;
    const openBraces = (fixedContent.match(/{/g) || []).length;
    const closeBraces = (fixedContent.match(/}/g) || []).length;
    const openBrackets = (fixedContent.match(/\[/g) || []).length;
    const closeBrackets = (fixedContent.match(/]/g) || []).length;

    // Remove any trailing partial key-value pair (e.g., truncated mid-string)
    fixedContent = fixedContent.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "");
    // Also remove trailing comma after cleanup
    fixedContent = fixedContent.replace(/,\s*$/, "");

    // Close unclosed brackets and braces
    for (let i = 0; i < openBrackets - closeBrackets; i++) fixedContent += "]";
    for (let i = 0; i < openBraces - closeBraces; i++) fixedContent += "}";

    try {
      const result = JSON.parse(fixedContent);
      console.log(`[JSON_EXTRACT] ${label}: recovered truncated JSON successfully`, {
        fixedLength: fixedContent.length,
        topLevelKeys: getTopLevelKeys(result),
      });
      return result;
    } catch (secondError) {
      console.error(
        `[JSON_EXTRACT] ${label}: all parse attempts failed.`,
        `\nFirst error: ${(firstError as Error).message}`,
        `\nSecond error: ${(secondError as Error).message}`,
        `\nRaw content (first 800 chars): ${raw.substring(0, 800)}`,
        `\nRaw content (last 300 chars): ${raw.substring(Math.max(0, raw.length - 300))}`,
      );
      throw new Error(`Failed to parse ${label}: invalid JSON from LLM`);
    }
  }
}

export function getTopLevelKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value as Record<string, unknown>).slice(0, 12);
}

// ============= LLM CALL HELPER (OpenRouter Only) =============

export async function callLLMWithFallback(
  prompt: string,
  options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
    jsonLabel?: string;
  } = {},
): Promise<LLMCallResult> {
  const primaryModel = options.model || PRIMARY_LLM_MODEL;
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.maxTokens ?? 8192;
  // Time budget: Supabase gateway kills at ~150s. Give primary model max time.
  const GATEWAY_BUDGET_MS = 140_000;
  const budgetStart = Date.now();

  const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");

  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  // Try primary model first, then fallback on transport or parse/format errors.
  const modelsToTry = getLLMModelsToTry(primaryModel);
  let lastError: Error | null = null;

  console.log(`[LLM] Starting request${options.jsonLabel ? ` for ${options.jsonLabel}` : ""}`, {
    modelsToTry,
    temperature,
    maxTokens,
    gatewayBudgetMs: GATEWAY_BUDGET_MS,
    promptLength: prompt.length,
    promptPreview: prompt.length > 100 ? prompt.substring(0, 100) + '...[truncated]' : prompt,
  });

  for (let index = 0; index < modelsToTry.length; index++) {
    const model = modelsToTry[index];
    const nextModel = modelsToTry[index + 1];

    // Compute per-attempt timeout: primary gets 130s max, fallback gets rest
    const elapsed = Date.now() - budgetStart;
    const remaining = GATEWAY_BUDGET_MS - elapsed;
    const perAttemptMs = nextModel
      ? Math.min(130_000, Math.max(20_000, remaining - 15_000))
      : Math.max(15_000, remaining - 3_000);

    if (remaining < 10_000) {
      console.warn(`[LLM] Time budget exhausted (${remaining}ms left), skipping ${model}`);
      break;
    }

    try {
      console.log(`[LLM] Attempt ${index + 1}/${modelsToTry.length}${options.jsonLabel ? ` for ${options.jsonLabel}` : ""}`, {
        model,
        nextModel: nextModel || null,
        perAttemptMs,
        remainingBudgetMs: remaining,
      });

      const result = await callOpenRouter(OPENROUTER_API_KEY, model, prompt, temperature, maxTokens, perAttemptMs);

      if (options.jsonLabel) {
        console.log(`[LLM] Validating JSON response from ${model} for ${options.jsonLabel}`, {
          contentLength: result.content.length,
          contentPreview: result.content.length > 100 ? result.content.substring(0, 100) + '...[truncated]' : result.content,
        });

        const parsedContent = extractJsonFromLLMResponse(result.content, options.jsonLabel);
        console.log(`[LLM] JSON validation succeeded for ${options.jsonLabel}`, {
          model,
          contentLength: result.content.length,
          topLevelKeys: getTopLevelKeys(parsedContent),
        });

        return {
          ...result,
          parsedContent,
        };
      }

      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[LLM] ${model} failed${options.jsonLabel ? ` for ${options.jsonLabel}` : ""}: ${lastError.message}. ${nextModel ? `Falling back to ${nextModel}...` : "No more fallbacks."}`,
      );
    }
  }

  throw lastError || new Error("All LLM models failed");
}

export async function callOpenRouter(
  apiKey: string,
  model: string,
  prompt: string,
  temperature: number,
  maxTokens: number,
  timeoutMs: number = 110_000,
): Promise<LLMCallResult> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  console.log(`[LLM] Calling OpenRouter with ${model}...`, {
    temperature,
    maxTokens,
    timeoutMs,
    promptLength: prompt.length,
    promptPreview: prompt.length > 100 ? prompt.substring(0, 100) + '...[truncated]' : prompt,
  });

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://motionmax.io",
        "X-Title": "MotionMax",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    console.log(`[LLM] OpenRouter ${model} HTTP response received`, {
      status: response.status,
      ok: response.ok,
      durationMs,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(`[LLM] OpenRouter ${model} request failed`, {
        status: response.status,
        durationMs,
        errorPreview: errText.substring(0, 500),
      });
      throw new Error(`OpenRouter ${model} failed (${response.status}): ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error(`[LLM] OpenRouter ${model} returned empty content`, {
        durationMs,
        responseKeys: Object.keys(data || {}),
      });
      throw new Error(`No content received from OpenRouter (${model})`);
    }

    console.log(`[LLM] OpenRouter ${model} success: ${data.usage?.total_tokens || 0} tokens, ${durationMs}ms`, {
      contentLength: typeof content === "string" ? content.length : 0,
      contentPreview: typeof content === "string" ? (content.length > 100 ? content.substring(0, 100) + '...[truncated]' : content) : null,
    });
    return {
      content,
      tokensUsed: data.usage?.total_tokens || 0,
      provider: "openrouter",
      durationMs,
      model,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      const elapsed = Date.now() - startTime;
      console.warn(`[LLM] OpenRouter ${model} timed out after ${elapsed}ms (limit: ${timeoutMs}ms)`);
      throw new Error(`OpenRouter ${model} timed out after ${Math.round(elapsed / 1000)}s`);
    }
    throw err;
  }
}
