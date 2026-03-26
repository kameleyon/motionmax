/**
 * Scene post-processing helpers for the generateVideo handler.
 * Mirrors the post-LLM processing from:
 *   supabase/functions/generate-video/index.ts — handleScriptPhase
 *
 * Extracted to keep handler file under 300 lines.
 */

// ── Constants ──────────────────────────────────────────────────────

const ALLOWED_PARALINGUISTIC_TAGS = [
  "clear throat", "sigh", "sush", "cough",
  "groan", "sniff", "gasp", "chuckle", "laugh",
];

// ── Types ──────────────────────────────────────────────────────────

export interface ParsedScene {
  number?: number;
  voiceover?: string;
  visualPrompt?: string;
  visual_prompt?: string;
  subVisuals?: string[];
  sub_visuals?: string[];
  duration?: number;
  narrativeBeat?: string;
  title?: string;
  subtitle?: string;
  coverTitle?: string;
  [key: string]: unknown;
}

export interface ParsedScript {
  title?: string;
  scenes?: ParsedScene[];
  characters?: Record<string, string>;
  visualPrompt?: string;
  visual_prompt?: string;
  [key: string]: unknown;
}

export interface ProcessedResult {
  scenes: ParsedScene[];
  totalImages: number;
  title: string;
}

// ── Voiceover Sanitizer ────────────────────────────────────────────

/** Remove labels, markdown, and non-allowed bracketed tags from voiceover. */
export function sanitizeVoiceover(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) =>
      line
        .replace(
          /^\s*(?:hook|scene\s*\d+|narrator|body|solution|conflict|choice|formula)\s*[:\-–—]\s*/i,
          "",
        )
        .replace(/^\s*\[[^\]]+\]\s*/g, ""),
    );
  let out = lines.join(" ");

  // Remove bracketed content EXCEPT allowed paralinguistic tags
  out = out.replace(/\[([^\]]+)\]/g, (match, content) => {
    const normalized = (content as string).toLowerCase().trim();
    if (ALLOWED_PARALINGUISTIC_TAGS.includes(normalized)) return match;
    return " ";
  });

  out = out.replace(/[*_~`]+/g, "");
  return out.replace(/\s{2,}/g, " ").trim();
}

// ── Voiceover word cap ─────────────────────────────────────────────

/** Max words per scene for "short" length (~15-16s at 2.5 words/sec). */
const SHORT_MAX_WORDS = 40;

/** Truncate voiceover at a sentence boundary to fit the word cap. */
function capVoiceover(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;

  // Find the last sentence boundary within the limit
  const truncated = words.slice(0, maxWords).join(" ");
  const lastPeriod = Math.max(truncated.lastIndexOf("."), truncated.lastIndexOf("!"), truncated.lastIndexOf("?"));
  if (lastPeriod > truncated.length * 0.5) {
    return truncated.substring(0, lastPeriod + 1);
  }
  return truncated + ".";
}

// ── Scene Post-Processor ───────────────────────────────────────────

/**
 * Post-process LLM-generated scenes:
 *  1. Sanitize voiceovers (+ cap words for "short" length)
 *  2. Append style prompt to visualPrompt & subVisuals
 *  3. Force duration = 15
 *  4. Calculate totalImages (1 primary + up to 2 sub-visuals per scene)
 */
export function postProcessScenes(
  parsedScript: ParsedScript,
  stylePrompt: string,
  projectType: string,
  length?: string,
): ProcessedResult {
  const rawScenes = parsedScript.scenes || [];
  const isShort = length === "short";

  const scenes = rawScenes.map((s, idx) => {
    const vp = s.visualPrompt || s.visual_prompt || "";
    const subs = s.subVisuals || s.sub_visuals || [];

    let voiceover = sanitizeVoiceover(s.voiceover);
    if (isShort) voiceover = capVoiceover(voiceover, SHORT_MAX_WORDS);

    return {
      ...s,
      number: s.number ?? idx + 1,
      voiceover,
      visualPrompt: `${vp}\n\nSTYLE: ${stylePrompt}`,
      subVisuals: subs.map((sv: string) => `${sv}\n\nSTYLE: ${stylePrompt}`),
      duration: 15,
    };
  });

  let totalImages = 0;
  for (const scene of scenes) {
    totalImages += 1; // Primary image
    const subCount = scene.subVisuals?.length || 0;
    totalImages += Math.min(subCount, 2);
  }

  // SmartFlow is always at least 1 image
  if (projectType === "smartflow") {
    totalImages = Math.max(totalImages, 1);
  }

  const title = parsedScript.title || "Untitled Video";
  return { scenes, totalImages, title };
}
