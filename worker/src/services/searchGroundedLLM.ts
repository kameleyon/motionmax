/**
 * Unified entry point for web-search-grounded LLM calls.
 *
 * Primary path: OpenRouter `google/gemini-3.5-flash` with the OpenRouter
 * `web` plugin (Exa-powered search). This is the cheaper/faster route
 * and avoids the per-Google-Cloud-project access denials we hit on the
 * native Gemini path (2026-05-25 logs: "Your project has been denied
 * access" across all keys).
 *
 * Fallback: native Gemini via `callGeminiWithKeyRotation` with the
 * `googleSearch` tool. Walks every configured GOOGLE_TTS_API_KEY_*
 * before giving up. Kept as a safety net so existing callers still
 * work if OpenRouter is down or returns a hard error.
 *
 * Callers should prefer this wrapper over calling either provider
 * directly so the choice of search backend lives in one place.
 */

import { callOpenRouterLLM } from "./openrouter.js";
import { callGeminiWithKeyRotation } from "./geminiNative.js";

/** OpenRouter model used for grounded research. Confirmed available
 *  via openrouter.ai/api/v1/models on 2026-05-25; 1M context window,
 *  $1.50/1M prompt tokens. */
const OPENROUTER_SEARCH_MODEL = "google/gemini-3.5-flash";

/** Fallback model name reported by the native-Gemini path for logging.
 *  Mirrors `DEFAULT_MODEL` in geminiNative.ts — keep in sync if that
 *  changes. */
const FALLBACK_GEMINI_MODEL = "gemini-2.5-pro";

export interface SearchGroundedOpts {
  system: string;
  user: string;
  /** Optional public image URLs for multimodal grounding. */
  imageUrls?: string[];
  temperature?: number;
  maxTokens?: number;
  /** Abort timeout. Applied to the native-Gemini fallback; OpenRouter
   *  uses its own per-call timeout (scaled by maxTokens). */
  timeoutMs?: number;
}

export interface SearchGroundedResult {
  text: string;
  /** Which backend actually answered — important when the OpenRouter
   *  call fell back to native Gemini, so callers can log the real
   *  provider/model rather than always assuming OpenRouter. */
  provider: "openrouter" | "google";
  model: string;
}

export async function callSearchGroundedLLM(opts: SearchGroundedOpts): Promise<SearchGroundedResult> {
  try {
    const text = await callOpenRouterLLM(
      { system: opts.system, user: opts.user },
      {
        model: OPENROUTER_SEARCH_MODEL,
        maxTokens: opts.maxTokens ?? 4000,
        temperature: opts.temperature,
        enableWebSearch: true,
        imageUrls: opts.imageUrls,
      },
    );
    return { text, provider: "openrouter", model: OPENROUTER_SEARCH_MODEL };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[SearchGrounded] OpenRouter ${OPENROUTER_SEARCH_MODEL} failed (${msg.slice(0, 200)}) — falling back to native Gemini`,
    );
    const text = await callGeminiWithKeyRotation({
      system: opts.system,
      user: opts.user,
      imageUrls: opts.imageUrls,
      enableSearch: true,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
    });
    return { text, provider: "google", model: FALLBACK_GEMINI_MODEL };
  }
}
