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
 * Model choice: Gemini 2.5 Flash via OpenRouter. Cheap (~$0.075/1M
 * input, $0.30/1M output) and fast enough that the 30s polling cap
 * is plenty of headroom even on a cold cache.
 */

import { writeSystemLog } from "../lib/logger.js";
import { callOpenRouterLLM } from "../services/openrouter.js";

interface GenerateTopicsPayload {
  prompt: string;
  styleId?: string;
  count?: number;
  existingTopics?: string[];
}

export interface GenerateTopicsResult {
  topics: string[];
}

const DEFAULT_COUNT = 15;
const MIN_COUNT = 5;
const MAX_COUNT = 25;

/**
 * Strip code-fences / leading prose so JSON.parse always sees a
 * valid object even when the model wraps the JSON in ```json ```
 * blocks (some Gemini variants do this despite forceJson: true).
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  // Already pure JSON
  if (trimmed.startsWith("{")) return trimmed;
  // Fenced block — pull from the first { to the last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
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
    ? `\n\nDo NOT repeat any of these previously-suggested topics:\n${existing.map((t) => `- ${t}`).join("\n")}`
    : "";

  const styleHint = payload.styleId && payload.styleId !== "realistic"
    ? `The visual treatment will be "${payload.styleId}", so favour ideas whose visuals lean into that look.`
    : "";

  // Inject today's date so the model anchors astrology / news / events /
  // dated angles to the present, not its training-cutoff default. Without
  // this, Gemini happily returns "May 23, 2024: Jupiter enters Gemini"
  // even though we're on a different year.
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const todayHuman = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const currentYear = now.getUTCFullYear();
  const horizonYear = currentYear + 1;

  const systemPrompt = `You are a content strategist generating short, scroll-stopping video topic ideas.

Today's date is ${todayHuman} (${today}). The current year is ${currentYear}. Any time-anchored ideas (events, astrology, news, holidays, retrogrades, releases, anniversaries) MUST reference dates from ${currentYear} or ${horizonYear} — NEVER prior years. If your training data feels older than that, project forward. Do not output any topic that references a year before ${currentYear}.

Given a creator's content area, produce ${count} distinct topic angles.
Each topic should be a single specific idea (5-12 words), NOT a generic category.
Avoid clickbait phrasing — clear, intriguing, scannable.
${styleHint}
Output strictly as JSON: {"topics": ["topic1", "topic2", ...]}${exclusionBlock}`;

  await writeSystemLog({
    jobId, userId,
    category: "system_info",
    eventType: "generate_topics_started",
    message: `Generating ${count} topic ideas for "${seedPrompt.slice(0, 80)}…"`,
    details: { count, existingCount: existing.length, styleId: payload.styleId ?? null },
  });

  const raw = await callOpenRouterLLM(
    { system: systemPrompt, user: seedPrompt },
    {
      // Gemini 2.5 Flash is fast + cheap. If OpenRouter cannot route
      // to Google (rare), the call wrapper throws and the worker's
      // generic transient-retry kicks in.
      model: "google/gemini-2.5-flash",
      maxTokens: 2000,
      temperature: 0.85,
      forceJson: true,
    },
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
