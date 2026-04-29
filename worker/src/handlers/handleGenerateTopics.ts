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

interface GenerateTopicsPayload {
  prompt: string;
  styleId?: string;
  count?: number;
  existingTopics?: string[];
  /** Pre-processed source attachments string (text files inlined,
   *  URL/YouTube/GitHub markers, image URLs). Comes from the intake's
   *  processAttachments() before the worker job is queued. */
  sources?: string;
}

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

  const exclusionBlock = existing.length > 0
    ? `\n\nIMPORTANT — These topics have already been suggested. Do NOT repeat them or any close variant:\n${existing.map((t) => `- ${t}`).join("\n")}\n\nGenerate topics that explore COMPLETELY DIFFERENT angles, sub-topics, or perspectives.`
    : "";

  const todayHuman = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

  const sourcesBlock = (typeof payload.sources === "string" && payload.sources.trim().length > 0)
    ? `\n\nUser-provided sources (treat as PRIMARY references — do not drift away from these):\n${payload.sources.trim()}`
    : "";

  const systemPrompt = `You are a content strategist who generates compelling clickbait topic titles.
Stay strictly on the requested subject and reject off-topic themes.`;

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

Return ONLY valid JSON in this exact shape (no prose, no code fences):
{"topics": ["title 1", "title 2", "..."]}`;

  await writeSystemLog({
    jobId, userId,
    category: "system_info",
    eventType: "generate_topics_started",
    message: `Generating ${count} topic ideas for "${seedPrompt.slice(0, 80)}…"`,
    details: { count, existingCount: existing.length, styleId: payload.styleId ?? null },
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
    timeoutMs: 120_000,
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
