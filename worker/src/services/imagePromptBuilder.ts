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
}

// ── Format descriptions ────────────────────────────────────────────

function formatDescription(format: string): string {
  if (format === "portrait") return "VERTICAL 9:16 portrait orientation (tall, like a phone screen)";
  if (format === "square") return "SQUARE 1:1 aspect ratio (equal width and height)";
  return "HORIZONTAL 16:9 landscape orientation (wide, like a TV screen)";
}

// ── Character instructions ─────────────────────────────────────────

function buildCharacterInstructions(
  characterBible: Record<string, string>,
  characterDescription: string,
): string {
  if (Object.keys(characterBible).length > 0) {
    const descriptions = Object.entries(characterBible)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n");
    return `\n\nCHARACTER CONSISTENCY BIBLE (use EXACT descriptions for any characters that appear):\n${descriptions}\n\nCRITICAL CHARACTER RULES:\n1. If any of these characters appear in this scene, they MUST match their description EXACTLY\n2. PAY ATTENTION TO AGE: If the scene mentions childhood/youth/past, use the corresponding age-specific character\n3. TEMPORAL CONTEXT: Match the character's age to the TIME PERIOD being depicted in this specific scene\n4. VISUAL CONTINUITY: Characters at different ages must share key traits but reflect correct age\n5. ENVIRONMENTAL CONTEXT: Match clothing, hairstyles, and surroundings to the time period\n6. Do NOT show a 35-year-old adult when depicting someone's childhood`;
  }
  if (characterDescription) {
    return `\n\nCHARACTER APPEARANCE REQUIREMENTS (apply consistently across ALL scenes):\n${characterDescription}\n\nCONSISTENCY RULES:\n1. ALL characters in this scene MUST match the above description exactly\n2. Maintain consistent skin tone, hair color/style, clothing style, and body type\n3. Do not invent different appearances — the creator specified these traits for a reason`;
  }
  return "";
}

// ── Cover / text overlay instructions ─────────────────────────────

function buildTextInstructions(
  scene: Scene,
  subIndex: number,
  sceneIndex: number,
  style: string,
): string {
  if (sceneIndex === 0 && subIndex === 0 && scene.coverTitle) {
    return `\nCOVER IMAGE TITLE (MANDATORY):\n- Render "${scene.coverTitle}" as a BOLD, PROMINENT headline title on this cover image\n- The title should be large enough to be instantly readable and eye-catching\n- Text style must match the visual style of the illustration\n- Position the title prominently (top, center, or overlaid on focal area)\n- Use contrasting colors or effects (shadow, outline, glow) to ensure maximum legibility\n- This is the COVER IMAGE - it must grab attention immediately`;
  }
  const includeTextOverlay = TEXT_OVERLAY_STYLES.includes(style.toLowerCase());
  if (includeTextOverlay && scene.title && subIndex === 0) {
    return `\nTEXT OVERLAY: Render "${scene.title}" as headline, "${scene.subtitle || ""}" as subtitle.\nText must be LEGIBLE, correctly spelled, and integrated into the composition.`;
  }
  return "";
}

// ── Main builder ───────────────────────────────────────────────────

export function buildImagePrompt(
  visualPrompt: string,
  scene: Scene,
  subIndex: number,
  sceneIndex: number,
  opts: BuildPromptOptions,
): string {
  const { format, style, characterBible, characterDescription } = opts;
  const styleDescription = getStylePrompt(style);
  const fmtDesc = formatDescription(format);
  const textInstructions = buildTextInstructions(scene, subIndex, sceneIndex, style);
  const characterInstructions = buildCharacterInstructions(characterBible, characterDescription);

  return `CREATE A HIGHLY DETAILED, PRECISE, AND ACCURATE ILLUSTRATION:

SCENE DESCRIPTION: ${visualPrompt}

FORMAT REQUIREMENT: ${fmtDesc}. The image MUST be composed for this exact aspect ratio.

VISUAL STYLE: ${styleDescription}

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
${textInstructions}
${characterInstructions}

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
