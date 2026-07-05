/**
 * Image prompt builder for the worker images phase.
 * Mirrors buildImagePrompt() from supabase/functions/generate-video/index.ts.
 *
 * Produces the full elaborated prompt sent to Hypereal / Replicate for each
 * image task (primary visual + sub-visuals).
 */

import { getStylePrompt, TEXT_OVERLAY_STYLES } from "./prompts.js";

// ── Types ──────────────────────────────────────────────────────────

export interface Scene {
  number: number;
  voiceover: string;
  visualPrompt: string;
  subVisuals?: string[];
  duration: number;
  title?: string;
  subtitle?: string;
  coverTitle?: string;
  imageUrl?: string;
  imageUrls?: string[];
  audioUrl?: string;
  [key: string]: unknown;
}

export interface ImageTask {
  sceneIndex: number;
  subIndex: number;
  prompt: string;
  taskIndex: number;
}

export interface BuildPromptOptions {
  format: string;
  style: string;
  characterBible: Record<string, string>;
  characterDescription: string;
  isSmartFlow: boolean;
  /** The video's title — used as the last-resort fallback for the
   *  Scene 1 cover headline when the LLM didn't emit a coverTitle and
   *  the scene has no title of its own. Ensures the first image ALWAYS
   *  gets a headline for cinematic + explainer videos. */
  videoTitle?: string;
  /** Cinematic mode. In cinematic ONLY the Scene 1 cover carries a title;
   *  every other scene gets an explicit no-title instruction and must depict
   *  its OWN per-scene description (never echo the first scene). Explainer /
   *  smartflow keep their per-scene text overlays. */
  isCinematic?: boolean;
}

// ── Format descriptions ────────────────────────────────────────────

function formatDescription(format: string): string {
  if (format === "portrait") return "VERTICAL 9:16 portrait orientation (tall, like a phone screen)";
  if (format === "square") return "SQUARE 1:1 aspect ratio (equal width and height)";
  return "HORIZONTAL 16:9 landscape orientation (wide, like a TV screen)";
}

// ── Character instructions ─────────────────────────────────────────
//
// Order of authority (highest first):
//   1. User-supplied characterDescription (typed by the creator in the UI) — GROUND TRUTH
//   2. LLM-generated characterBible (derived from the script) — must NOT contradict #1
//
// Both are included when present so the user's explicit input is never dropped.

function buildCharacterInstructions(
  characterBible: Record<string, string>,
  characterDescription: string,
): string {
  const parts: string[] = [];

  if (characterDescription && characterDescription.trim()) {
    parts.push(
      `USER CHARACTER APPEARANCE — HIGHEST PRIORITY (MUST MATCH EXACTLY):\n${characterDescription.trim()}\n\n` +
      `This is the creator's explicit specification. Every character in this image MUST match these traits ` +
      `(skin tone, hair color/style, clothing, body type, species, age, distinguishing features). ` +
      `If anything below contradicts this, THIS description wins.`
    );
  }

  if (Object.keys(characterBible).length > 0) {
    const descriptions = Object.entries(characterBible)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n");
    parts.push(
      `CHARACTER CONSISTENCY BIBLE (per-character details — MUST match the USER CHARACTER APPEARANCE above):\n${descriptions}\n\n` +
      `Rules: (1) Every character that appears MUST match their bible entry EXACTLY — same hair, clothing, ` +
      `skin tone, build, and features. (2) Match age to the TIME PERIOD being depicted (childhood → child, ` +
      `past → period-appropriate). (3) Do NOT swap outfits or hair between scenes unless the story explicitly ` +
      `requires it. (4) NEVER whitewash or alter ethnicity.`
    );
  }

  if (parts.length === 0) return "";
  return `\n\n=== CHARACTER REQUIREMENTS (NON-NEGOTIABLE) ===\n${parts.join("\n\n")}`;
}

// ── Cover / text overlay instructions ─────────────────────────────

/** Aspect-ratio-specific safe-area guidance so the cover title fits the
 *  frame without any word being cropped at the edges. Portrait (9:16)
 *  gets the strictest treatment because that's the social-media default
 *  and a tall canvas is the easiest to overrun horizontally. */
function titleFitGuidance(format: string): string {
  if (format === "portrait") {
    return `This is a VERTICAL 9:16 phone screen. The title MUST fit a tall 9:16 frame: keep every letter well inside the central safe area with generous left/right margins and clear of the extreme top and bottom. Stack the title on 2-3 lines if needed rather than letting any word run off the sides. NOTHING in the title may be cropped or touch the frame edges.`;
  }
  if (format === "square") {
    return `This is a SQUARE 1:1 frame. Center the title with even margins on all four sides; no letter may touch or be cropped at any edge.`;
  }
  return `This is a WIDESCREEN 16:9 frame. Keep the title within the central safe area with clear margins on all sides; no letter may be cropped at any edge.`;
}

/** Mandatory cover-headline block for the first image. */
function buildCoverTitleInstruction(title: string, format: string): string {
  return `\nCOVER IMAGE TITLE (MANDATORY — THIS IS THE FIRST/COVER IMAGE):\n- Render "${title}" as a BOLD, PROMINENT headline on this image\n- ${titleFitGuidance(format)}\n- Make the title large and instantly readable, but it MUST fit the frame COMPLETELY — scale the text down or wrap onto multiple lines so every single word is fully visible\n- Title typography MUST match the art style of the illustration\n- Use contrasting colors or effects (shadow, outline, glow) for maximum legibility\n- This is the COVER IMAGE — it must grab attention immediately`;
}

function buildTextInstructions(
  scene: Scene,
  subIndex: number,
  sceneIndex: number,
  style: string,
  format: string,
  videoTitle?: string,
  isCinematic?: boolean,
): string {
  // Scene 1, primary image → ALWAYS render a cover headline (cinematic +
  // explainer). Fall back coverTitle → scene.title → videoTitle so a
  // missing LLM coverTitle never leaves the cover untitled.
  if (sceneIndex === 0 && subIndex === 0) {
    const title = (scene.coverTitle || scene.title || videoTitle || "").trim();
    if (title) {
      return buildCoverTitleInstruction(title, format);
    }
  }

  // CINEMATIC: only the cover (Scene 1 primary, handled above) carries a title.
  // Every other image must render NO title text AND depict its own per-scene
  // description — this stops the title from bleeding onto every scene and stops
  // the images echoing the first scene instead of following their own prompt.
  // (Must come BEFORE the TEXT_OVERLAY_STYLES branch, which would otherwise
  // stamp scene.title on every cinematic scene when the chosen style happens to
  // be a text-overlay style like minimalist/doodle/stick.)
  if (isCinematic) {
    return `\nNO TITLE / NO TEXT: This is NOT the cover image. Do NOT render any title, headline, caption, subtitle, label, watermark, or any overlaid words on this image. Depict ONLY the SCENE DESCRIPTION above for THIS specific scene — do not reuse, repeat, or echo the first/cover scene's composition, subject, or text.`;
  }

  const includeTextOverlay = TEXT_OVERLAY_STYLES.includes(style.toLowerCase());
  if (includeTextOverlay && scene.title && subIndex === 0) {
    return `\nTEXT OVERLAY: Render "${scene.title}" as headline, "${scene.subtitle || ""}" as subtitle.\nText must be LEGIBLE, correctly spelled, and integrated into the composition.`;
  }
  return "";
}

// ── Embedded overlay-title stripper ────────────────────────────────

/** Remove on-screen TITLE / typography text that an older script LLM may
 *  have baked into a scene's visualPrompt (e.g. "'THE JOURNEY BEGINS' in
 *  bold typography fading in over mist."). Used for cinematic NON-cover
 *  scenes only, so existing projects stop rendering a title on every
 *  scene without needing a full script regeneration. Conservative: only
 *  strips clauses that pair a quoted phrase with a typography/overlay
 *  keyword, or explicit overlay directives ("text overlay", "title
 *  card", "the words … appear") — diegetic signage/banners are left
 *  alone. The cover (Scene 1 primary) keeps its title upstream. */
export function stripOverlayTitleText(visualPrompt: string): string {
  let p = visualPrompt;
  // "'TITLE' in/as bold typography/lettering/title text …" → to sentence end
  p = p.replace(
    /['"‘’“”][^'"‘’“”\n]{1,80}['"‘’“”]\s+(?:in|as)\s+[^.?!\n]*?(?:typography|lettering|title text|headline text|bold text|large text)\b[^.?!\n]*[.?!]?\s*/gi,
    "",
  );
  // Explicit overlay directives.
  p = p.replace(
    /\b(?:text overlay|title card|title text|headline text)\b\s*[:\-]?[^.?!\n]*[.?!]?\s*/gi,
    "",
  );
  // "the words '…' appear/fade in/overlay …"
  p = p.replace(
    /\bthe words?\b[^.?!\n]*?(?:appear|fade|overlay|shown|written|display)[^.?!\n]*[.?!]?\s*/gi,
    "",
  );
  return p.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Main builder ───────────────────────────────────────────────────

export function buildImagePrompt(
  visualPrompt: string,
  scene: Scene,
  subIndex: number,
  sceneIndex: number,
  opts: BuildPromptOptions,
): string {
  const { format, style, characterBible, characterDescription, videoTitle, isCinematic } = opts;
  const styleDescription = getStylePrompt(style);
  const fmtDesc = formatDescription(format);
  const textInstructions = buildTextInstructions(scene, subIndex, sceneIndex, style, format, videoTitle, isCinematic);
  const characterInstructions = buildCharacterInstructions(characterBible, characterDescription);

  // Cinematic non-cover scenes: strip any on-screen title text the script
  // LLM may have baked into the visualPrompt (older generations did this),
  // so the title stays on the Scene-1 cover only. The cover keeps its text.
  const isCoverImage = sceneIndex === 0 && subIndex === 0;
  const sceneDescription = (isCinematic && !isCoverImage)
    ? stripOverlayTitleText(visualPrompt)
    : visualPrompt;

  // Character requirements go FIRST (after the create directive) so image models
  // weight them heavily. Style description comes AFTER character so style can't
  // override appearance (e.g. 3D style defaulting to generic 3D character looks).
  // The title/no-title block (textInstructions) sits HIGH — right after the
  // scene description — NOT at the end: gpt-image-2 truncates prompts to ~3900
  // chars by keeping the HEAD, so a title instruction placed at the tail of a
  // long cinematic prompt would be silently dropped (the Scene-1 cover title
  // would vanish, and the per-scene no-title instruction would never apply).
  return `CREATE A HIGHLY DETAILED, PRECISE, AND ACCURATE ILLUSTRATION:
${characterInstructions}

SCENE DESCRIPTION: ${sceneDescription}
${textInstructions}

FORMAT REQUIREMENT: ${fmtDesc}. The image MUST be composed for this exact aspect ratio.

VISUAL STYLE: ${styleDescription}
(Style defines the rendering technique ONLY. It MUST NOT override the character requirements above — if the style suggests a generic look, still match the specified character traits.)

GENERATION REQUIREMENTS:
- You have an in-depth knowledge about visual content and how to reach the target population
- You are highly creative, with a touch of boldness, elegant and wow-factor
- Your style is dynamic, detailed with catchy, smart choices of illustration and presentation
- You are modern and an avant-garde when it comes to content presentation
- Create a modern, ULTRA DETAILED image with rich textures, accurate lighting, and proper shadows
- Ensure ANATOMICAL ACCURACY for any humans, animals, or creatures depicted
- If depicting real public figures or celebrities, generate someone who looks similar to them
- Pay attention to CONTEXT and SETTING - assess the content to understand scene environment, mood
- Establish and maintain CHARACTER CONSISTENCY - keep physical traits coherent throughout
- Establish and maintain ENVIRONMENT CONSISTENCY - backgrounds and setting elements must be cohesive
- Include PRECISE DETAILS: fabric textures, skin details, environmental elements, atmospheric effects
- Ensure COMPOSITIONAL BALANCE appropriate for the ${format} format
- Make the scene feel NATURAL and BELIEVABLE within the chosen style

SUBJECT IDENTIFICATION:
- Identify the main TOPIC and PRIMARY SUBJECT of this scene
- Ensure all IMPORTANT ELEMENTS mentioned in the description are clearly visible
- Maintain visual HIERARCHY - the main subject should be the focal point

REMINDER: Re-read the CHARACTER REQUIREMENTS section at the top of this prompt before generating. Every character MUST match those traits exactly — this takes priority over style defaults.

OUTPUT: Ultra high resolution, professional illustration with dynamic composition, clear visual hierarchy, cinematic quality, bold creativity, and meticulous attention to detail.`;
}

// ── Task list builder ──────────────────────────────────────────────

/**
 * Build the full ordered list of image tasks for a generation.
 * SmartFlow: 1 image per scene. Others: 3 per scene (1 primary + 2 sub-visuals).
 */
export function buildImageTasks(
  scenes: Scene[],
  opts: BuildPromptOptions,
): ImageTask[] {
  const { isSmartFlow } = opts;
  const tasks: ImageTask[] = [];
  let taskIndex = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    // Primary image
    tasks.push({
      sceneIndex: i,
      subIndex: 0,
      prompt: buildImagePrompt(scene.visualPrompt, scene, 0, i, opts),
      taskIndex: taskIndex++,
    });

    if (!isSmartFlow) {
      // Sub-visual 1
      const sub1Prompt = (scene.subVisuals && scene.subVisuals[0])
        ? scene.subVisuals[0]
        : `${scene.visualPrompt} — alternative angle or mid-shot detail view`;
      tasks.push({
        sceneIndex: i,
        subIndex: 1,
        prompt: buildImagePrompt(sub1Prompt, scene, 1, i, opts),
        taskIndex: taskIndex++,
      });

      // Sub-visual 2
      const sub2Prompt = (scene.subVisuals && scene.subVisuals[1])
        ? scene.subVisuals[1]
        : `${scene.visualPrompt} — close-up detail or emotional focal point`;
      tasks.push({
        sceneIndex: i,
        subIndex: 2,
        prompt: buildImagePrompt(sub2Prompt, scene, 2, i, opts),
        taskIndex: taskIndex++,
      });
    }
  }

  return tasks;
}
