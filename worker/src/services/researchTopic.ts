/**
 * AI-powered topic research grounded on live web search.
 *
 * Primary backend: OpenRouter `google/gemini-3.5-flash` with the
 * OpenRouter `web` plugin (Exa-powered). Falls back to native Gemini
 * 2.5 Pro with `googleSearch` if OpenRouter errors — both arranged
 * behind `callSearchGroundedLLM`.
 *
 * Generates a factual research brief about a topic before script
 * generation. Covers key facts, character descriptions (race, gender,
 * ethnicity, appearance), historical/cultural context, geography,
 * clothing, and verifiable details needed for accurate visual rep.
 *
 * Set GEMINI_API_KEY on the worker; optionally GEMINI_MODEL to override
 * the model id. Falls back gracefully (returns "") if the key is
 * missing so old projects without the env var still build.
 */

import { writeApiLog } from "../lib/logger.js";
import { llmCostUsd } from "../lib/providerRates.js";
import { callSearchGroundedLLM } from "./searchGroundedLLM.js";
import {
  buildSourceGroundingDirective,
  contentHasAttachedSources,
} from "./sourceGroundingDirective.js";

// Built at request time with current date injected — see buildResearchPrompt()
function buildResearchPrompt(): string {
  // Wave E-Legal Part J — Tongue i18n hygiene.
  // Use ISO 8601 + UTC offset rather than en-US locale-formatted strings
  // ("Thursday, November 5, 2026" + "11:42 AM PST"). The locale-formatted
  // form biased the LLM towards US conventions (English month names,
  // 12-hour clock, US-style weekday ordering) in any downstream language.
  // ISO 8601 is locale-neutral and unambiguous; the model is fully
  // capable of re-rendering it in its own output language if it needs
  // to surface a date to the end user.
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);            // YYYY-MM-DD
  const timeStr = now.toISOString().slice(11, 16) + " UTC";  // HH:MM UTC

  return `You are a meticulous fact-checker and visual research assistant for a cinematic AI video production team.

TODAY'S DATE (ISO 8601): ${dateStr}, ${timeStr}. All research must reflect the world AS OF TODAY. Do not use outdated information. If a person has changed appearance, teams have new rosters, or events have occurred recently, use the MOST CURRENT information available.

STEP 1 - RESEARCH FIRST: Before generating any visual descriptions, thoroughly research the given topic. Pull verified facts, data, statistics, scholarly consensus, and contextual information from credible sources. Understand WHAT is true about the subject before describing HOW it should look. This applies to any topic - medical, scientific, cultural, sports, historical, or otherwise. If the topic involves claims, behaviors, symptoms, comparisons, or debates, establish the factual foundation first. If you cannot verify something, mark it "UNVERIFIED." Do not skip this step.

STEP 2 - VISUAL TRANSLATION: Once the research is complete, translate those verified facts into production-ready visual descriptions for the scriptwriter and image generator. Every visual detail below must be grounded in the research from Step 1.

Your job is to research the given topic and provide VERIFIED, ACCURATE facts that the video scriptwriter and image generator will use. The video team will create visual scenes based on your research, so accuracy of VISUAL DETAILS is critical.

For EVERY person/character mentioned, you MUST research and provide:
- **RACE & ETHNICITY**: Exact race, skin tone, ethnic background. DO NOT assume. Look it up.
- **GENDER**: Verified gender. DO NOT assume.
- **PHYSICAL APPEARANCE**: What they actually look like - hair color/style, facial features, body type, age
- **CLOTHING**: What they wore/wear in the relevant context. Historical accuracy matters.
  - For sports: exact team jersey colors for THAT SPECIFIC game/event, not just general team colors
  - For historical figures: period-accurate clothing
  - For modern figures: their known style/appearance

For EVERY location/setting mentioned:
- **GEOGRAPHY**: What does it actually look like? Tropical? Arid? Urban? Rural?
- **WEATHER/CLIMATE**: Is it snowing or sunny? Rainy season or dry?
- **ARCHITECTURE**: What do buildings look like in that region/era?
- **CULTURAL MARKERS**: Signs, language on buildings, cultural details

For EVERY event mentioned:
- **DATE & CONTEXT**: When did it happen? What were the circumstances?
- **KEY DETAILS**: Specific facts a viewer would notice if wrong (jersey colors, team lineups, scores, etc.)
- **CULTURAL SIGNIFICANCE**: Why does this matter? What's the emotional context?

IMPORTANT RULES:
- For REAL PEOPLE (celebrities, athletes, politicians, historical/biblical figures): You MUST describe their ACTUAL appearance based on verified knowledge. Kylian Mbappé is Black with dark brown skin. Jesus of Nazareth was a Middle Eastern Jewish man - NOT white with blue eyes. Moses was a Hebrew man from Egypt. Martin Luther King Jr. was a Black man. DO NOT whitewash or Europeanize anyone.
- If you're not sure about a detail, say "UNVERIFIED" - never make up facts
- If the topic is fictional, note what's established canon vs interpretation
- If the topic is historical, prioritize scholarly consensus and regional ethnic accuracy
- Be HYPER-SPECIFIC with physical descriptions: "warm dark brown skin, close-cropped tightly coiled black hair, strong jawline, athletic 6'0 build" - NOT "African American man"
- Include VISUAL details the AI image/video generator needs - this is for creating IMAGES and VIDEOS, not text
- For sports events: specify EXACT jersey colors, numbers, and team kits for THAT SPECIFIC match/event

Return your research as a structured brief in plain text (NOT JSON). Use sections: ## RESEARCH FINDINGS (verified facts, data, and context from Step 1), ## CHARACTER DESCRIPTIONS (with FULL physical appearance), ## VISUAL SETTING, ## CULTURAL CONTEXT. Keep it under 1500 words.`;
}

/**
 * Research a topic before script generation.
 * Returns a research brief string to inject into the script prompt.
 *
 * `attribution` is required so the resulting api_call_logs row carries
 * real userId / generationId for finops. Pass `{ userId: null,
 * generationId: null }` only for system warmups or smoke tests — never
 * in the production script-generation path. (C-8-5 / C-9-7)
 */
export async function researchTopic(
  content: string,
  attribution: { userId: string | null; generationId: string | null; jobId: string | null } = { userId: null, generationId: null, jobId: null },
): Promise<string> {
  if (!process.env.GOOGLE_TTS_API_KEY && !process.env.GOOGLE_TTS_API_KEY_2 && !process.env.GOOGLE_TTS_API_KEY_3) {
    console.warn("[Research] No GOOGLE_TTS_API_KEY (or _2/_3) set — skipping web-grounded research");
    return "";
  }

  console.log(`[Research] Starting topic research via Gemini 3.1 Pro Preview + googleSearch (${content.length} chars input)`);
  const startTime = Date.now();

  // Extract image URLs from content for multimodal research
  const imageUrls: string[] = [];
  const imagePattern = /\[SOURCE IMAGE\]\s*(https?:\/\/[^\s]+)/g;
  let match;
  while ((match = imagePattern.exec(content)) !== null) {
    imageUrls.push(match[1]);
  }

  // When the user attached sources (PDFs, fetched web pages, YouTube
  // metadata, GitHub READMEs, images), they almost certainly contain
  // ground-truth facts the model would otherwise hallucinate around.
  // Raise the truncation cap from 50K → 200K so a typical attached PDF
  // survives intact (gemini-3.5-flash via OpenRouter has a 1M-token
  // context — 200K chars fits comfortably under that). Non-source
  // content keeps the old 50K limit to avoid bloating typical research
  // requests for nothing.
  const hasSources = contentHasAttachedSources(content);
  const contentCharCap = hasSources ? 200_000 : 50_000;
  const truncatedContent = content.substring(0, contentCharCap);

  // The user-message prefix gets the directive front-loaded so the
  // model sees "READ THE SOURCES FIRST" before it sees anything else
  // in the turn. The same directive is appended to the system prompt
  // below for authority; recency bias in the user slot pairs with
  // primacy in the system slot to maximize compliance.
  const directivePrefix = hasSources ? buildSourceGroundingDirective() + "\n\n" : "";
  const userText = `${directivePrefix}Research this topic for an AI-generated cinematic video. Use Google Search to pull current, factually accurate information — appearances, dates, events, rosters, releases. Cite where it matters.\n\n${truncatedContent}`;

  // System prompt gets the directive appended (not prepended) — the
  // existing buildResearchPrompt opens with the date / mission framing
  // which we don't want to bury. The directive lands at the end so
  // recency bias inside the system slot favors it.
  const systemPrompt = hasSources
    ? `${buildResearchPrompt()}\n${buildSourceGroundingDirective()}`
    : buildResearchPrompt();

  if (imageUrls.length > 0) {
    console.log(`[Research] Including ${imageUrls.length} attached image URL(s) for multimodal grounding`);
  }
  if (hasSources) {
    console.log(`[Research] Detected attached sources — grounding directive applied, content cap raised to ${contentCharCap.toLocaleString()} chars`);
  }

  try {
    const result = await callSearchGroundedLLM({
      system: systemPrompt,
      user: userText,
      imageUrls,
      temperature: 0.3,
      maxTokens: 4000,
      timeoutMs: 90_000,
    });
    const brief = result.text;
    const elapsed = Date.now() - startTime;
    console.log(`[Research] Complete via ${result.provider}/${result.model} (${brief.length} chars, ${(elapsed / 1000).toFixed(1)}s)`);
    // Approximate cost = (input chars / 4) tokens in + (output chars / 4)
    // tokens out, priced via providerRates. Neither backend surfaces the
    // model's exact usage counters back to us yet — TODO: thread them
    // through so we use the real billed token count. The cost key still
    // points at the Gemini Pro rate sheet (close-enough for both the
    // OpenRouter gemini-3.5-flash path and the native Gemini fallback;
    // exact rates diverge but research calls are a small slice of
    // overall spend).
    const approxInputTokens = Math.ceil((userText.length + buildResearchPrompt().length) / 4);
    const approxOutputTokens = Math.ceil(brief.length / 4);
    writeApiLog({
      userId: attribution.userId,
      generationId: attribution.generationId,
      jobId: attribution.jobId,
      provider: result.provider, model: result.model,
      status: "success", totalDurationMs: elapsed,
      cost: llmCostUsd("google_gemini_pro_preview", approxInputTokens, approxOutputTokens),
      error: undefined,
    }).catch((err) => { console.warn('[Research] background log failed:', (err as Error).message); });
    return brief;
  } catch (err) {
    console.warn(`[Research] Failed: ${(err as Error).message} — continuing without research`);
    writeApiLog({
      userId: attribution.userId,
      generationId: attribution.generationId,
      jobId: attribution.jobId,
      // Both backends failed (OpenRouter primary + Gemini fallback).
      // Log under the primary so the error attributes to where we
      // started; the fallback's own message will appear in `error`.
      provider: "openrouter", model: "google/gemini-3.5-flash",
      status: "error", totalDurationMs: Date.now() - startTime,
      cost: 0, error: (err as Error).message,
    }).catch((err) => { console.warn('[Research] background log failed:', (err as Error).message); });
    return "";
  }
}
