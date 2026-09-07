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

/** Word ceiling per scene for "short" length (~18s at 2.5 words/sec).
 *
 *  This is deliberately well above the ~28-word target the script prompt asks
 *  for (buildCinematic / buildDoc2Video). It is a runaway guard, not a budget
 *  enforcer: the export sizes each clip to its own audio (see
 *  sceneEncoder.imageAudioToClip), so a scene a few words over target just
 *  runs ~1-2s long — it does not desync. Capping at the target itself is what
 *  chopped scenes the LLM wrote in good faith at 29-31 words. */
const SHORT_MAX_WORDS = 45;

const countWords = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Trim an over-budget voiceover on a SENTENCE boundary — never mid-clause.
 *
 * A mid-sentence cut is unrecoverable: the narration audibly stops dead
 * ("...and almost nobody in.") and no downstream stage can repair it. Running
 * a scene long is merely a timing nuisance. So we drop only WHOLE trailing
 * sentences, and only enough of them to get back under the ceiling — never
 * the first sentence, so a single over-long sentence is returned intact
 * rather than butchered.
 */
function capVoiceover(text: string, maxWords: number): string {
  if (countWords(text) <= maxWords) return text;

  // Split into sentences, keeping each terminator (and any closing quote or
  // bracket) attached to the sentence it ends.
  const sentences = text.match(/[^.!?]+[.!?]+["'”’)\]]*\s*/g);
  if (!sentences || sentences.length < 2) return text; // nothing safe to drop

  let kept = "";
  let keptWords = 0;
  for (const sentence of sentences) {
    const n = countWords(sentence);
    // Always keep the first sentence, whatever its length.
    if (keptWords > 0 && keptWords + n > maxWords) break;
    kept += sentence;
    keptWords += n;
  }
  return kept.trim() || text;
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

    // LLMs sometimes use alternative field names for voiceover
    let voiceover = sanitizeVoiceover(
      s.voiceover || (s as any).narration || (s as any).script || (s as any).narrative || (s as any).text || ""
    );
    // SmartFlow has a single scene with long narration — don't cap it
    if (isShort && projectType !== "smartflow") voiceover = capVoiceover(voiceover, SHORT_MAX_WORDS);

    // SmartFlow single scene needs 30-60s for narration; others default to 15s
    const duration = projectType === "smartflow" ? (s.duration || 60) : 11;

    return {
      ...s,
      number: s.number ?? idx + 1,
      voiceover,
      visualPrompt: `${vp}\n\nSTYLE: ${stylePrompt}`,
      subVisuals: subs.map((sv: string) => `${sv}\n\nSTYLE: ${stylePrompt}`),
      duration,
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
