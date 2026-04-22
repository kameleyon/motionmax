/**
 * Generate a cheap text-only storyboard for the Intake form's
 * "Storyboard peek" card. Returns up to 8 scene titles + one-line
 * descriptions — no images, no TTS, no cost beyond a single LLM call
 * (~$0.001 at Hypereal's gemini-3.1-fast rate).
 *
 * task_type: "preview_storyboard"
 * payload:  { prompt: string, mode: 'cinematic' | 'doc2video' | 'smartflow' }
 * result:   { scenes: Array<{ title: string; description: string }> }
 *
 * The user sees this update live as they tweak their prompt, so they
 * know roughly what 8 scenes MotionMax would assemble before they
 * commit to a full (~$1-4) generation.
 */

import { callHyperealLLM } from "../services/openrouter.js";

interface PreviewStoryboardPayload {
  prompt: string;
  mode?: string;
}

interface SceneLite {
  title: string;
  description: string;
}

export async function handlePreviewStoryboard(
  _jobId: string,
  payload: PreviewStoryboardPayload,
  _userId?: string,
): Promise<{ scenes: SceneLite[] }> {
  const prompt = (payload.prompt ?? "").trim();
  if (prompt.length < 10) {
    throw new Error("Storyboard prompt too short (need 10+ chars)");
  }

  const mode = payload.mode || "cinematic";
  const sceneCount = mode === "smartflow" ? 4 : 8;

  const system =
    `You are a creative director breaking a video idea into a short ` +
    `storyboard. Output EXACTLY ${sceneCount} scenes in strict JSON. ` +
    `Each scene has a punchy 2-5 word title and a single sentence ` +
    `description (max 90 characters) that captures the visual beat. ` +
    `Schema: {"scenes":[{"title":"string","description":"string"}]}.`;

  const user = `Video idea: ${prompt}\n\nReturn ${sceneCount} storyboard scenes as JSON.`;

  console.log(`[PreviewStoryboard] mode=${mode} prompt=${prompt.length} chars → ${sceneCount} scenes`);

  const raw = await callHyperealLLM(
    { system, user },
    { maxTokens: 900, forceJson: true, temperature: 0.7 },
  );

  // callHyperealLLM with forceJson returns a raw string that SHOULD be
  // valid JSON. We strip any accidental pre-fill/markdown and parse.
  let parsed: { scenes?: unknown };
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
    parsed = JSON.parse(cleaned.startsWith("{") ? cleaned : "{" + cleaned);
  } catch {
    throw new Error(`Storyboard LLM returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const scenes: SceneLite[] = rawScenes
    .filter((s): s is { title?: unknown; description?: unknown } => typeof s === "object" && s !== null)
    .map((s) => ({
      title: typeof s.title === "string" ? s.title.slice(0, 60) : "",
      description: typeof s.description === "string" ? s.description.slice(0, 140) : "",
    }))
    .filter((s) => s.title && s.description)
    .slice(0, sceneCount);

  if (scenes.length === 0) {
    throw new Error("Storyboard LLM returned no valid scenes");
  }

  return { scenes };
}
