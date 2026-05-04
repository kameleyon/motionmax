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
 * Model choice: Claude Sonnet 4.6 via OpenRouter. More accurate on
 * dated/factual angles than Gemini Flash (which fabricated wrong
 * astronomy dates). Slightly slower + pricier but the 30s polling
 * window still has plenty of headroom.
 */

import { writeSystemLog } from "../lib/logger.js";
import { callGemini } from "../services/geminiNative.js";
import { processContentAttachments } from "../services/processAttachments.js";

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

  const todayHuman = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

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

  const systemPrompt = `You are a content strategist who generates compelling clickbait topic titles.
Stay strictly on the requested subject and reject off-topic themes.${languageDirective}`;

  const userPrompt = `Today is ${todayHuman}.

Use Google Search to research everything related to the topic requested below — and ONLY that topic. Pull the most current, factually accurate information. Use any source URLs or material the user provides as primary references. Do not drift into adjacent or unrelated subjects.

Topic:
${seedPrompt}${sourcesBlock}
${exclusionBlock}

Generate exactly ${count} unique, SHORT, clickbait-worthy titles based on the inputs above.

Requirements:
- Each title MUST be UNDER 10 WORDS — short, punchy, irresistible
- Use curiosity gaps, power words, unexpected angles
- Create titles that make people NEED to click
- Each title should cover a DIFFERENT angle or sub-topic
- Titles MUST be directly relevant to the requested subject
- Vary the format: provocative statements, questions, revelations, challenges
${langCode === "en" ? "" : `- Every title MUST be written in ${langName} (idiomatic, not translated)`}

Return ONLY valid JSON in this exact shape (no prose, no code fences):
{"topics": ["title 1", "title 2", "..."]}`;

  await writeSystemLog({
    jobId, userId,
    category: "system_info",
    eventType: "generate_topics_started",
    message: `Generating ${count} topic ideas for "${seedPrompt.slice(0, 80)}…"`,
    details: { count, existingCount: existing.length, styleId: payload.styleId ?? null, language: langCode },
  });

  // Native Google Gemini API with googleSearch tool — gives us live
  // web-grounded responses, the only way the model can produce real
  // current-year astrology / news / event dates instead of fabricating
  // them from training data. JSON mode is incompatible with the
  // search tool on Google's API, so the model returns prose-with-JSON
  // that extractJson() unwraps.
  const raw = await callGemini({
    system: systemPrompt,
    user: userPrompt,
    enableSearch: true,
    temperature: 0.85,
    // Search-grounded responses include the model's reasoning over the
    // search hits + citations + the final JSON. 4000 tokens was getting
    // truncated mid-array ("topics": ...<cutoff>). Bumped well above
    // worst-case to leave the JSON room to close cleanly.
    maxTokens: 12_000,
    // Search-grounded calls fan out to live web results before
    // generating, routinely running 60–90s+ on a slow search day.
    // 120s left almost no headroom and was tripping our AbortController
    // on legitimate-but-slow responses; 180s gives ~2x median latency.
    timeoutMs: 180_000,
  });

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
