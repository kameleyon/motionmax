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
    short: { count: 15, targetDuration: 165, avgSceneDuration: 11, maxWords: 28 },
    brief: { count: 28, targetDuration: 308, avgSceneDuration: 11, maxWords: 28 },
    presentation: { count: 36, targetDuration: 396, avgSceneDuration: 11, maxWords: 28 },
  };
  const cfg = lengthCfg[p.length] || lengthCfg.brief;
  const targetWords = cfg.maxWords;
  const styleDesc = getStylePrompt(p.style, p.customStyle);
  const dims = getImageDimensions(p.format);
  const includeText = TEXT_OVERLAY_STYLES.includes(p.style.toLowerCase());
  const maxTokens = p.length === "presentation" ? 24000 : p.length === "brief" ? 16000 : 10000;

  const presenterGuidance = p.presenterFocus
    ? `\n=== PRESENTER GUIDANCE ===\n${p.presenterFocus}\n` : "";
  const characterGuidance = p.characterDescription
    ? `\n=== USER-SPECIFIED CHARACTER APPEARANCE (GROUND TRUTH — NON-NEGOTIABLE) ===\n${p.characterDescription}\n\n` +
      `THIS IS THE CREATOR'S EXPLICIT INPUT AND IT OVERRIDES ANYTHING YOU INFER FROM THE CONTENT.\n` +
      `MANDATORY RULES:\n` +
      `1. Your "characters" object MUST be built FROM this description — copy the exact traits (species, skin tone, hair, clothing, build, age, distinguishing features) into every matching character entry.\n` +
      `2. EVERY visualPrompt that features a character MUST include these appearance details verbatim — do NOT summarize, paraphrase, or substitute.\n` +
      `3. Do NOT invent a different look. Do NOT default to a generic protagonist. Do NOT change ethnicity, species, or key features.\n` +
      `4. If the description conflicts with what "feels right" for the content, THIS description wins.\n`
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

CRITICAL — DO NOT COPY THE ART STYLE TEXT INTO THE PER-SCENE visualPrompt FIELD.
The image renderer automatically appends the full ART STYLE block to every prompt at render time. If you embed it again in visualPrompt, it duplicates and clutters the Editor's prompt UI for the user. Each scene's visualPrompt should describe ONLY the scene-specific content (subject, action, setting, framing) — keep it under ~80 words. Never start a visualPrompt with "STYLE:", "ART STYLE:", "Handcrafted Digital Clay", "Cinematic 3D Animation", or any other style preamble.

=== TIMING REQUIREMENTS (CRITICAL - STRICT ENFORCEMENT) ===
- Target duration: ${cfg.targetDuration} seconds
- Create EXACTLY ${cfg.count} scenes. NOT ${cfg.count - 1}, NOT ${cfg.count + 1}. EXACTLY ${cfg.count}. If you return fewer or more scenes, the ENTIRE generation will be REJECTED and restarted from scratch
- EACH scene voiceover MUST be EXACTLY ${targetWords} words. Not 18, not 22, not 25. EXACTLY ${targetWords} words.
- At ~2.5 words/sec, ${targetWords} words = 11 seconds of audio per scene. This is the TARGET.
- COUNT YOUR WORDS for every scene. If a voiceover has fewer than ${targetWords - 3} words or more than ${targetWords + 2} words, it is WRONG.
- Do NOT write short, clipped scenes. Fill the full ${targetWords} words with meaningful, flowing content.
- Set each scene "duration" to ${cfg.avgSceneDuration}

=== NARRATIVE ARC ===
1. HOOK (Scenes 1-2): Create intrigue (High energy, fast cuts)
2. CONFLICT (Early-middle): Show tension
3. CHOICE (Middle): Fork in the road
4. SOLUTION (Later): Show method/progress
5. FORMULA (Final): Summary visual

=== VOICEOVER STYLE ===
- Write CONTINUOUS, FLOWING narration — the voiceover across all scenes should read as ONE cohesive script, not independent fragments
- Each scene's voiceover must CONNECT to the previous scene — use transitions, continuation, cause-and-effect, or narrative momentum
- NEVER restart the narrative in each scene. Scene 5 should feel like the natural continuation of scene 4, not a new beginning
- Natural human tone, conversational tone — engaging but coherent
- DELIVERY GUARDRAILS (hard "do-not"): No whisper, no ASMR, no dramatic theatrical delivery, no breathy intimate tone, no emphatic shouting. Speak like a confident host having a real conversation — not like a stage actor or a meditation app. Avoid paralinguistic tags that imply whisper / sigh / gasp / dramatic pause; if you need emphasis, get it from word choice and rhythm, not vocal theatrics.
- The FIRST scene hooks the audience. Every scene AFTER that BUILDS on what came before
- Vary pacing: some scenes push forward, some pause to reflect, some escalate — like a real speaker
- NO labels, NO stage directions, NO markdown — just raw spoken text
- **PRESERVE THE USER'S EXACT TERMINOLOGY**: If the user uses specific names, titles, or terms, keep them throughout — do NOT replace with generic pronouns
${p.disableExpressions
  ? `- Write CLEAN, plain speech — NO paralinguistic tags, NO bracketed cues, NO expressions like [chuckle], [sigh], [laugh], [gasp], etc.`
  : `- Include paralinguistic tags sparingly for emotional emphasis: [sigh], [chuckle], [gasp], [laugh]
- Use them only at key emotional moments, not every scene`}

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
  const truncatedContent = p.content.length > 15000 ? p.content.substring(0, 15000) + "\n\n[Content truncated — focus on the key themes above]" : p.content;
  // Inject character guidance into SYSTEM prompt too so the LLM reads it as
  // authoritative ground truth before analyzing the content.
  const finalSystem = characterGuidance ? `${system}\n${characterGuidance}` : system;
  const user = `Content: ${truncatedContent}\n${presenterGuidance}${characterGuidance}${brandSec}`;
  return { system: finalSystem, user, maxTokens };
}
