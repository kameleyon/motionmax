/**
 * Worker handler for the `generate_topics` job type.
 *
 * Backs the "Pre-plan your content" panel inside the intake-form
 * ScheduleBlock: the user types a content area (e.g. "Daily Stoic
 * meditations for entrepreneurs") and we ask a fast LLM to produce
 * 15 distinct video-topic angles they can opt into queueing.
 *
 * The result is written to `video_generation_jobs.result` as
 *   { topics: ["topic1", "topic2", ...] }
 * which the front-end polls (1.5s interval, 30s timeout — see the
 * useVoiceCloning pattern in src/hooks/useVoiceCloning.ts).
 *
 * Re-roll path: when the user clicks "Regenerate", the front-end
 * resends the original prompt PLUS the previously-shown batch under
 * `existingTopics`. We pass that into the system prompt as an
 * exclusion list so the model dedups across requests.
 *
 * Two-stage pipeline:
 *   1. RESEARCH — Gemini with googleSearch grounding. Walks every
 *      configured Google API key (`GOOGLE_TTS_API_KEY_3 → _2 → base`)
 *      on 403, so one bad-project key doesn't sink the request.
 *      Gemini ONLY gathers facts; it never writes titles. If every
 *      Google key fails, we skip research and proceed empty-handed.
 *   2. TITLE WRITING — Claude Sonnet 4.6 via OpenRouter, ALWAYS.
 *      Receives the research brief (when available) as factual
 *      grounding context, plus the user's prompt + sources. Even if
 *      research came back empty, Claude still produces titles from
 *      the prompt + sources alone — the pipeline never fails just
 *      because Google is down.
 *
 * Search grounding is a Gemini-only feature on the native Google API;
 * neither OpenRouter nor Hypereal expose it, which is why the research
 * stage is locked to Gemini specifically.
 */

import { writeSystemLog } from "../lib/logger.js";
import { callGeminiWithKeyRotation } from "../services/geminiNative.js";
import { callOpenRouterLLM } from "../services/openrouter.js";
import { processContentAttachments } from "../services/processAttachments.js";
import { isTransientError } from "../lib/retryClassifier.js";

interface GenerateTopicsPayload {
  prompt: string;
  styleId?: string;
  count?: number;
  existingTopics?: string[];
  /** Pre-processed source attachments string (text files inlined,
   *  URL/YouTube/GitHub markers, image URLs). Comes from the intake's
   *  processAttachments() before the worker job is queued. */
  sources?: string;
  /** ISO 639-1 code (en, fr, es, ht, de, it, nl, ru, zh, ja, ko).
   *  Topic titles are written in this language instead of defaulting
   *  to English. */
  language?: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  fr: "French",
  es: "Spanish",
  ht: "Haitian Creole",
  de: "German",
  it: "Italian",
  nl: "Dutch",
  ru: "Russian",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
};

export interface GenerateTopicsResult {
  topics: string[];
}

const DEFAULT_COUNT = 15;
const MIN_COUNT = 5;
const MAX_COUNT = 25;

/**
 * Pull the JSON object out of the model response. Search-grounded
 * Gemini calls return prose with the JSON embedded somewhere; we
 * scan from the first { to the LAST matching }. If the response was
 * truncated (no closing brace), throw a clear error so the caller
 * can surface a useful retry message instead of a confusing
 * "Unexpected end of JSON input".
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(
      `model response had no complete JSON object (likely truncated): ${trimmed.slice(0, 200)}…`,
    );
  }
  return trimmed.slice(firstBrace, lastBrace + 1);
}

export async function handleGenerateTopics(
  jobId: string,
  payload: GenerateTopicsPayload,
  userId: string,
): Promise<GenerateTopicsResult> {
  const seedPrompt = (payload?.prompt ?? "").trim();
  if (seedPrompt.length < 4) {
    throw new Error("generate_topics: prompt must be at least 4 characters");
  }

  // Clamp count into a sensible window so a typo'd payload (e.g. 0 or
  // 9999) never blows up the model's output budget.
  const requestedCount = typeof payload.count === "number" ? payload.count : DEFAULT_COUNT;
  const count = Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.floor(requestedCount)));

  // Exclusion list — newline-bulleted so the LLM has an easy time
  // skimming it. Cap at the most recent 60 to stay well under the
  // model's context budget if a user spams Regenerate.
  const existing = Array.isArray(payload.existingTopics)
    ? payload.existingTopics.filter((t) => typeof t === "string" && t.trim().length > 0).slice(-60)
    : [];

  // When existing topics are provided we want NEW topics with NEW
  // subjects but EXACTLY THE SAME structural format (prefix, casing,
  // punctuation, word style). Without the format-match clause the LLM
  // reads "explore different angles" and abandons whatever naming
  // scheme the existing topics established (e.g. "3 of Clubs: Stop X"
  // → drops the card prefix and just writes generic self-help).
  const exclusionBlock = existing.length > 0
    ? `\n\nEXISTING TOPICS (do NOT repeat these or any close variant — but DO match their format exactly):\n${existing.map((t) => `- ${t}`).join("\n")}\n\nFORMAT CONSISTENCY — CRITICAL:\nStudy the existing topics above. Match their EXACT structural format in every new topic:\n- Same prefix pattern (if they all start with a card name, place name, date, etc., yours must too — using a NEW value of the same kind)\n- Same casing rules (Title Case vs Sentence case)\n- Same punctuation style (colons, em-dashes, etc.)\n- Same approximate length and rhythm\n- Same tone\nThe new topics should feel like they belong in the same series. Only the subject changes — never the format.`
    : "";

  // Wave E-Legal Part J — Tongue i18n hygiene.
  // Inject ISO 8601 (YYYY-MM-DD) into the AI prompt rather than the
  // en-US long-form string ("November 5, 2026"). The locale-formatted
  // string biased the LLM towards US conventions (e.g. month-day-year
  // ordering, English month names) in any downstream language. ISO is
  // unambiguous and locale-neutral; the LLM is fully capable of
  // rendering it in the requested output language if it ever needs to
  // surface the date to the user.
  const todayHuman = new Date().toISOString().slice(0, 10);

  // Expand any [PDF_URL]/[FETCH_URL]/[YOUTUBE_URL]/[GITHUB_URL] tags
  // into actual fetched/parsed content BEFORE we embed sources in the
  // prompt — without this, the LLM was seeing literal opaque tag
  // strings ("[PDF_URL] https://...") instead of the document body it
  // was supposed to ground topic ideas in. processContentAttachments
  // is idempotent on strings without the "--- ATTACHED SOURCES ---"
  // marker, so plain text sources pass through unchanged.
  let resolvedSources = "";
  if (typeof payload.sources === "string" && payload.sources.trim().length > 0) {
    try {
      resolvedSources = await processContentAttachments(payload.sources);
    } catch (err) {
      // A failed fetch on one source shouldn't kill the whole topic
      // job — log and fall back to the raw string so the model at
      // least sees the URLs.
      console.warn(
        `[GenerateTopics] processContentAttachments failed: ${(err as Error).message} — falling back to raw sources`,
      );
      resolvedSources = payload.sources;
    }
  }
  const sourcesBlock = resolvedSources.trim().length > 0
    ? `\n\nUser-provided sources (treat as PRIMARY references — do not drift away from these):\n${resolvedSources.trim()}`
    : "";

  // The model defaults to English if not told otherwise. Map the
  // schedule/intake language code to its display name and inject a
  // hard directive — both in the system prompt (for tone setting)
  // and the user prompt (for the JSON output requirement).
  const langCode = (payload.language ?? "en").toLowerCase();
  const langName = LANGUAGE_NAMES[langCode] ?? "English";
  const languageDirective = langCode === "en"
    ? ""
    : `\n\nLANGUAGE: Write every title in ${langName}. Do NOT use English. Titles must be natural, idiomatic ${langName} — not translated word-for-word from English.`;

  await writeSystemLog({
    jobId, userId,
    category: "system_info",
    eventType: "generate_topics_started",
    message: `Generating ${count} topic ideas for "${seedPrompt.slice(0, 80)}…"`,
    details: { count, existingCount: existing.length, styleId: payload.styleId ?? null, language: langCode },
  });

  // ── Step 1: Research (Gemini + googleSearch) — best-effort ─────────
  //
  // Gemini's ONLY job here is to gather current, factual context about
  // the topic via live web search — it does NOT write the titles. We
  // walk every configured GOOGLE_TTS_API_KEY_* in turn so one key
  // hitting a project-level 403 doesn't sink the request. If every
  // key fails (or research times out), we proceed without research
  // and let Claude write from the prompt + sources alone.
  const researchSystem = `You are a focused research assistant. Use Google Search to gather the most current, factual information about the topic the user describes. Return a tight research brief — facts, dates, names, current events, recent developments. NO titles, NO pitches, NO bullet-point ideas — just the raw factual context a writer would need to ground their work in reality.`;
  const researchUser = `Today is ${todayHuman}.

Research the following topic thoroughly using live web search. Pull the most current information. Use any user-provided sources as primary references.

Topic:
${seedPrompt}${sourcesBlock}

Return 2–4 short paragraphs of factual notes covering:
- What's happening now / latest state of the topic
- Key names, dates, numbers, recent events
- Notable angles or sub-themes worth knowing
- Any current-events context (rulings, releases, results, controversies) that a content creator should know

Do NOT write titles. Do NOT pitch video ideas. Just the factual brief.`;

  // Gemini search-grounded calls go through a 2-attempt loop. Google's
  // googleSearch tool latency varies — when the model issues many
  // queries a single attempt routinely runs past 3 minutes. We bumped
  // the per-attempt cap to 240s and give one extra try with a 20s
  // backoff on transient failures (timeouts, network blips, 5xx). Hard
  // errors (403 across all keys, prompt blocked, JSON parse) skip
  // straight to the fallback so we don't burn time retrying something
  // that won't change. After both attempts the pipeline falls back to
  // Claude writing from prompt + sources alone — the same graceful
  // degradation we've always had on Gemini failure.
  let researchBrief = "";
  const RESEARCH_TIMEOUT_MS = 240_000;
  const RESEARCH_MAX_ATTEMPTS = 2;
  const RESEARCH_RETRY_DELAY_MS = 20_000;
  for (let attempt = 1; attempt <= RESEARCH_MAX_ATTEMPTS; attempt++) {
    try {
      researchBrief = (await callGeminiWithKeyRotation({
        system: researchSystem,
        user: researchUser,
        enableSearch: true,
        temperature: 0.3, // factual mode — low variation
        maxTokens: 6_000,
        timeoutMs: RESEARCH_TIMEOUT_MS,
      })).trim();
      break; // success — exit the retry loop
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const canRetry = attempt < RESEARCH_MAX_ATTEMPTS && isTransientError(err);
      if (canRetry) {
        console.warn(
          `[GenerateTopics] Gemini research attempt ${attempt}/${RESEARCH_MAX_ATTEMPTS} failed (${msg.slice(0, 150)}) — retrying in ${RESEARCH_RETRY_DELAY_MS / 1000}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, RESEARCH_RETRY_DELAY_MS));
        continue;
      }
      console.warn(
        `[GenerateTopics] Gemini research failed (${msg.slice(0, 200)}) — Claude will write titles from prompt + sources only`,
      );
      await writeSystemLog({
        jobId, userId,
        category: "system_warning",
        eventType: "generate_topics_research_skipped",
        message: "Gemini research unavailable — titles generated without live web grounding",
        details: { error: msg.slice(0, 300), attempts: attempt },
      });
      break;
    }
  }

  // ── Step 2: Title writing (OpenRouter Claude Sonnet 4.6) ───────────
  //
  // Claude is ALWAYS the title writer. The research brief from step 1
  // is injected as grounding context (when available) so the titles
  // reference real current facts rather than training-data guesses.
  // When research is empty, Claude falls back to writing from the
  // prompt + user-provided sources.
  const researchBlock = researchBrief.length > 0
    ? `\n\nLATEST RESEARCH (live web context — use as factual grounding for titles):\n${researchBrief}\n`
    : "";

  const titleSystem = `You are a content strategist who generates compelling clickbait topic titles.
Stay strictly on the requested subject and reject off-topic themes.${languageDirective}`;

  const titleUser = `Today is ${todayHuman}.

Topic:
${seedPrompt}${sourcesBlock}${researchBlock}
${exclusionBlock}

Generate exactly ${count} unique, SHORT, clickbait-worthy titles based on the inputs above.

Requirements:
- Each title MUST be UNDER 10 WORDS — short, punchy, irresistible
- Use curiosity gaps, power words, unexpected angles
- Create titles that make people NEED to click
- Each title should cover a DIFFERENT angle or sub-topic
- Titles MUST be directly relevant to the requested subject
- Vary the format: provocative statements, questions, revelations, challenges
${researchBrief.length > 0 ? "- Ground every title in the LATEST RESEARCH above — reference real names, dates, and events, not generic angles" : ""}
${langCode === "en" ? "" : `- Every title MUST be written in ${langName} (idiomatic, not translated)`}

Return ONLY valid JSON in this exact shape (no prose, no code fences):
{"topics": ["title 1", "title 2", "..."]}`;

  const raw = await callOpenRouterLLM(
    { system: titleSystem, user: titleUser },
    { maxTokens: 12_000, temperature: 0.85, forceJson: true },
  );

  let parsed: { topics?: unknown };
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    throw new Error(
      `generate_topics: model returned non-JSON (${(err as Error).message}): ${raw.slice(0, 200)}`,
    );
  }

  const topics = Array.isArray(parsed.topics)
    ? parsed.topics
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        // Dedupe defensively in case the model ignores the exclusion list.
        .filter((t, i, arr) => arr.indexOf(t) === i)
        .slice(0, count)
    : [];

  if (topics.length === 0) {
    throw new Error("generate_topics: model returned zero usable topics");
  }

  await writeSystemLog({
    jobId, userId,
    category: "system_info",
    eventType: "generate_topics_completed",
    message: `Generated ${topics.length}/${count} topic ideas`,
    details: { delivered: topics.length, requested: count },
  });

  return { topics };
}
