/**
 * Prompt builder for Doc2Video project type.
 * Mirrors handleScriptPhase from supabase/functions/generate-video/index.ts.
 */

import {
  getStylePrompt,
  getImageDimensions,
  TEXT_OVERLAY_STYLES,
  CONTENT_COMPLIANCE_INSTRUCTION,
} from "./prompts.js";
import {
  buildLanguageSection,
  SUB_VISUALS_SECTION,
  PROMPT_ENGINEERING_SECTION,
  buildCoverTitleSection,
  buildOutputFormat,
  buildBrandSection,
} from "./promptSections.js";

export interface Doc2VideoParams {
  content: string; format: string; length: string; style: string;
  customStyle?: string; brandMark?: string; presenterFocus?: string;
  characterDescription?: string; voiceType?: string;
  disableExpressions?: boolean;
  language?: string;
}

export interface PromptResult { system: string; user: string; maxTokens: number; }

export function buildDoc2VideoPrompt(p: Doc2VideoParams): PromptResult {
  const lengthCfg: Record<string, { count: number; targetDuration: number; avgSceneDuration: number; maxWords: number }> = {
    short: { count: 10, targetDuration: 160, avgSceneDuration: 14, maxWords: 33 },
    brief: { count: 28, targetDuration: 420, avgSceneDuration: 15, maxWords: 37 },
    presentation: { count: 36, targetDuration: 540, avgSceneDuration: 15, maxWords: 37 },
  };
  const cfg = lengthCfg[p.length] || lengthCfg.brief;
  const targetWords = cfg.maxWords;
  const styleDesc = getStylePrompt(p.style, p.customStyle);
  const dims = getImageDimensions(p.format);
  const includeText = TEXT_OVERLAY_STYLES.includes(p.style.toLowerCase());
  const maxTokens = p.length === "presentation" ? 12000 : p.length === "brief" ? 10000 : 6000;

  const presenterGuidance = p.presenterFocus
    ? `\n=== PRESENTER GUIDANCE ===\n${p.presenterFocus}\n` : "";
  const characterGuidance = p.characterDescription
    ? `\n=== CHARACTER APPEARANCE ===\nAll human characters in visual prompts MUST match this description:\n${p.characterDescription}\nInclude these character details in EVERY visualPrompt that features people.\n`
    : "";

  const languageSection = buildLanguageSection(p.language);

  const system = `You are a DYNAMIC video script writer creating engaging, narrative-driven content.
${CONTENT_COMPLIANCE_INSTRUCTION}
${languageSection}

=== CONTENT ANALYSIS (CRITICAL - DO THIS FIRST) ===
Before writing the script, carefully analyze the content to identify:
1. KEY CHARACTERS: Who are the people/entities mentioned?
2. GENDER: Determine gender from context (names, pronouns, roles, topics)
   - Names like "Leo", "John", "Mike" → male
   - Names like "Sarah", "Maria", "Emma" → female
   - Topics like "motherhood", "pregnancy" → female protagonist
   - Topics like "fatherhood", "brotherhood" → male protagonist
3. ROLES & RELATIONSHIPS: Who does what?
4. VISUAL CONSISTENCY: The SAME character must look IDENTICAL across ALL scenes
5. TEMPORAL CONTEXT: Childhood → show AS A CHILD, Adult → show AS ADULT, etc.
   - The SAME person at different ages must share key visual traits (eye color, facial structure, ethnicity) but reflect the correct AGE
6. HISTORICAL/CULTURAL CONTEXT: Match clothing, hairstyles, technology to time period

=== VISUAL STYLE & ART DIRECTION ===
All image prompts must adhere to this style:
- ART STYLE: ${styleDesc}
- ASPECT RATIO: ${p.format} (${dims.width}x${dims.height})
- QUALITY: Ultra-detailed, 8K resolution, dramatic lighting
- CAMERA WORK: Use varied angles (Close-up, Wide shot, Low angle, Over-shoulder) to keep the video dynamic

=== TIMING REQUIREMENTS (CRITICAL - STRICT ENFORCEMENT) ===
- Target duration: ${cfg.targetDuration} seconds
- Create exactly ${cfg.count} scenes
${p.length === "short" ? `
⚠️ YOUTUBE SHORTS FORMAT — HARD LIMITS:
- The ENTIRE video MUST be between 2:30 and 2:50 (150–170 seconds). NEVER exceed 3 minutes.
- EACH scene voiceover: 12–14 seconds MAX (${targetWords} words MAXIMUM at ~2.5 words/sec)
- COUNT YOUR WORDS. If a voiceover exceeds ${targetWords} words, the generation WILL FAIL.
- Write TIGHT, punchy narration. Cut filler words ruthlessly.
` : `- EACH SCENE VOICEOVER MUST BE 12-15 SECONDS LONG. NO MORE THAN 15 SECONDS.
- That means each voiceover must be approximately ${targetWords} words (at ~2.5 words per second)
`}- MINIMUM 3 seconds per scene (to avoid glitchy flashes)
- If you exceed ${cfg.avgSceneDuration} seconds of spoken text per scene, the generation WILL FAIL.
- Set each scene "duration" to ${cfg.avgSceneDuration}

=== NARRATIVE ARC ===
1. HOOK (Scenes 1-2): Create intrigue (High energy, fast cuts)
2. CONFLICT (Early-middle): Show tension
3. CHOICE (Middle): Fork in the road
4. SOLUTION (Later): Show method/progress
5. FORMULA (Final): Summary visual

=== VOICEOVER STYLE ===
- ENERGETIC, conversational tone
- Start each scene with a hook
- NO labels, NO stage directions, NO markdown
- Just raw spoken text
${p.disableExpressions
  ? `- Write CLEAN, plain speech — NO paralinguistic tags, NO bracketed cues, NO expressions like [chuckle], [sigh], [laugh], [gasp], etc.
- Every character speaks in natural, unadorned sentences only.`
  : `- Include paralinguistic tags where appropriate for natural expression: [clear throat], [sigh], [sush], [cough], [groan], [sniff], [gasp], [chuckle], [laugh]
- Example: "Oh, that's interesting! [chuckle] Let me explain why..."`}

${SUB_VISUALS_SECTION}

${includeText ? `=== TEXT OVERLAY ===\n- Provide title (2-5 words) and subtitle for each scene` : ""}

=== CHARACTER BIBLE (REQUIRED) ===
You MUST create a "characters" object defining EVERY person/entity in the video.
This ensures visual CONSISTENCY - the same person looks identical across all scenes.

For each character specify using "CharacterName_age" format if showing same person at different ages:
- GENDER (male/female) - MUST match the content context
- AGE: The SPECIFIC age for this version of the character
- Ethnicity/skin tone if mentioned or implied
- Hair (color, style, length)
- Body type
- Clothing (period-appropriate, age-appropriate, culture-appropriate)
- Distinguishing features that remain CONSTANT across ages (eye color, facial structure, birthmarks)
- Distinguishing features that CHANGE with age (wrinkles, hair color/loss)

Example:
"Protagonist_child": "A 7-year-old Argentine boy with dark hair, brown eyes, small and thin build, wearing modest 1990s clothing, playful expression"
"Protagonist_adult": "A 35-year-old man with the SAME dark hair and brown eyes, athletic build, wearing Inter Miami jersey, determined expression"

${PROMPT_ENGINEERING_SECTION}

${buildCoverTitleSection('"The $10B Secret", "Why They ALL Failed", "Nobody Expected This", "The Hidden Truth"', styleDesc)}

${buildOutputFormat({
    charExamples: '"Protagonist_child": "A 7-year-old boy with dark hair, brown eyes...",\n    "Protagonist_adult": "A 35-year-old man with the SAME dark hair and brown eyes..."',
    narrativeBeatExample: "hook",
    voiceoverExample: "Script text here...",
    includeTextOverlay: includeText,
    textOverlayExample: includeText ? '"title": "Headline",\n      "subtitle": "Takeaway"' : undefined,
  })}`;

  const brandSec = buildBrandSection(p.brandMark);
  const user = `Content: ${p.content}\n${presenterGuidance}${characterGuidance}${brandSec}`;
  return { system, user, maxTokens };
}
