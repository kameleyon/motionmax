/**
 * Prompt builder for Storytelling project type.
 * Mirrors handleStorytellingScriptPhase from supabase/functions/generate-video/index.ts.
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
} from "./promptSections.js";
import type { PromptResult } from "./buildDoc2Video.js";

export interface StorytellingParams {
  storyIdea: string; format: string; length: string; style: string;
  customStyle?: string; brandMark?: string; inspiration?: string;
  tone?: string; genre?: string; characterDescription?: string; voiceType?: string;
  disableExpressions?: boolean;
  language?: string;
}

// ── Guide Lookups ──────────────────────────────────────────────────

const INSPIRATION_GUIDE: Record<string, string> = {
  "aaron-sorkin": "Write with sharp, rapid-fire dialogue. Use walk-and-talk energy, overlapping ideas, and intellectual sparring. Build momentum through rhythm and wit.",
  "quentin-tarantino": "Bold, unconventional narrative structure. Pop culture references, memorable monologues, and unexpected tonal shifts. Make every scene electric.",
  "nora-ephron": "Warm, romantic wit with observational humor. Relatable inner monologue, cozy settings, and heartfelt emotional beats.",
  "david-mamet": "Terse, rhythmic dialogue with staccato pacing. Subtext over text. Characters speak in fragments, interruptions, and loaded silences.",
  "agatha-christie": "Mystery and suspense with careful misdirection. Plant clues subtly, build tension, and deliver satisfying reveals.",
  "neil-gaiman": "Mythical storytelling blending the mundane with the magical. Lyrical prose, archetypal characters, and a sense of wonder.",
  "maya-angelou": "Poetic, uplifting prose with dignity and grace. Personal yet universal themes. The rhythm of spoken word.",
  "ernest-hemingway": "Sparse, powerful minimalism. Short sentences. Strong verbs. Let the emotion live in what's unsaid.",
};

const TONE_GUIDE: Record<string, string> = {
  casual: "Conversational and relaxed. Like talking to a friend over coffee.",
  professional: "Polished and authoritative. Clear, confident, and credible.",
  dramatic: "Heightened emotion and stakes. Build tension and release.",
  humorous: "Light, witty, with well-timed comedic beats. Don't force jokes—let humor emerge naturally.",
  inspirational: "Uplifting and motivating. Appeal to hopes and aspirations.",
  suspenseful: "Edge-of-seat tension. Strategic reveals and cliffhangers.",
  educational: "Clear explanations with engaging examples. Make complex ideas accessible.",
};

const GENRE_GUIDE: Record<string, string> = {
  documentary: "Factual narrative with human interest. Blend information with emotional storytelling.",
  fiction: "Character-driven narrative with plot arcs. Create a world the audience can inhabit.",
  educational: "Structured learning with engaging delivery. Examples, analogies, and clear takeaways.",
  marketing: "Persuasive narrative focused on value and transformation. End with clear call-to-action.",
  "personal-story": "Intimate, first-person narrative. Vulnerability, authenticity, and universal themes.",
  "news-report": "Objective journalism style. Who, what, when, where, why. Credible and timely.",
};

// ── Builder ────────────────────────────────────────────────────────

export function buildStorytellingPrompt(p: StorytellingParams): PromptResult {
  const lengthCfg: Record<string, { count: number; targetDuration: number; avgSceneDuration: number }> = {
    short: { count: 10, targetDuration: 150, avgSceneDuration: 15 },
    brief: { count: 28, targetDuration: 420, avgSceneDuration: 15 },
    extended: { count: 36, targetDuration: 540, avgSceneDuration: 15 },
    presentation: { count: 36, targetDuration: 540, avgSceneDuration: 15 },
  };
  const cfg = lengthCfg[p.length] || lengthCfg.brief;
  const targetWords = Math.floor(cfg.avgSceneDuration * 2.5);
  const sc = cfg.count;
  const styleDesc = getStylePrompt(p.style, p.customStyle);
  const dims = getImageDimensions(p.format);
  const includeText = TEXT_OVERLAY_STYLES.includes(p.style.toLowerCase());

  const inspirationSec = p.inspiration && p.inspiration !== "none" && INSPIRATION_GUIDE[p.inspiration]
    ? `\n=== WRITING INSPIRATION: ${p.inspiration.toUpperCase().replace(/-/g, " ")} ===\n${INSPIRATION_GUIDE[p.inspiration]}` : "";
  const toneSec = p.tone && TONE_GUIDE[p.tone]
    ? `\n=== TONE: ${p.tone.toUpperCase()} ===\n${TONE_GUIDE[p.tone]}` : "";
  const genreSec = p.genre && GENRE_GUIDE[p.genre]
    ? `\n=== GENRE: ${p.genre.toUpperCase().replace(/-/g, " ")} ===\n${GENRE_GUIDE[p.genre]}` : "";
  const charGuidance = p.characterDescription
    ? `\n=== CHARACTER APPEARANCE ===\nAll human characters in visual prompts MUST match this description:\n${p.characterDescription}\nInclude these character details in EVERY visualPrompt that features people.` : "";
  const brandSec = p.brandMark
    ? `\n=== BRAND ATTRIBUTION ===\nSubtly weave "${p.brandMark}" into the narrative as the source or presenter of this story.` : "";

  const languageSection = buildLanguageSection(p.language);

  const system = `You are a MASTER STORYTELLER creating an immersive visual narrative.
${CONTENT_COMPLIANCE_INSTRUCTION}
${languageSection}

=== CONTENT ANALYSIS (CRITICAL - DO THIS FIRST) ===
Before writing the story, carefully analyze the story idea to identify:
1. KEY CHARACTERS: Who are the people/creatures/entities in this story?
2. GENDER: Determine gender from context (names, pronouns, roles, topics)
3. ROLES & RELATIONSHIPS: Who is the protagonist? Antagonist? Supporting characters?
4. VISUAL CONSISTENCY: The SAME character must look IDENTICAL across ALL scenes
5. TEMPORAL CONTEXT: Childhood → show AS A CHILD, Adult → show AS ADULT, etc.
   - The SAME person at different ages must share key visual traits (eye color, facial structure, ethnicity) but reflect the correct AGE
6. HISTORICAL/CULTURAL CONTEXT: Match clothing, hairstyles, technology, environments to time period and culture

=== VISUAL STYLE & ART DIRECTION ===
All image prompts must adhere to this style:
- ART STYLE: ${styleDesc}
- ASPECT RATIO: ${p.format} (${dims.width}x${dims.height})
- QUALITY: Cinematic, ultra-detailed, 8K resolution, dramatic lighting
- CAMERA WORK: Use varied angles (Close-up, Wide shot, Low angle, Over-shoulder) to keep the video dynamic

=== TIMING REQUIREMENTS (CRITICAL - STRICT ENFORCEMENT) ===
- Target duration: ${cfg.targetDuration} seconds
- Create exactly ${sc} scenes
- EACH SCENE VOICEOVER MUST BE 12-15 SECONDS LONG. NO MORE THAN 15 SECONDS.
- That means each voiceover must be approximately ${targetWords} words (at ~2.5 words per second)
- MINIMUM 3 seconds per scene (to avoid glitchy flashes)
- If you exceed 15 seconds of spoken text per scene, the generation WILL FAIL. Keep it concise and impactful.
- Set each scene "duration" to exactly 15

=== NARRATIVE STRUCTURE ===
1. OPENING (Scene 1): Hook the audience immediately. Start in media res or with a provocative question.
2. RISING ACTION (Scenes 2-${Math.floor(sc * 0.4)}): Build the world, introduce conflict or stakes.
3. CLIMAX (Scenes ${Math.floor(sc * 0.4) + 1}-${Math.floor(sc * 0.7)}): Peak tension, key revelation, or turning point.
4. FALLING ACTION (Scenes ${Math.floor(sc * 0.7) + 1}-${sc - 1}): Consequences unfold, resolution begins.
5. CONCLUSION (Scene ${sc}): Satisfying ending with emotional resonance.

=== VOICEOVER STYLE ===
- Write CONTINUOUS narration—this is a story, not a presentation
- IMMERSIVE storytelling voice (not instructional)
- Show, don't tell—use sensory details and vivid imagery
- Vary sentence rhythm for musicality
- NO labels, NO stage directions, NO markdown
- **PRESERVE THE USER'S EXACT TERMINOLOGY**: If the user refers to a character as "Queen of Clubs", use "Queen of Clubs" throughout the story - do NOT replace names/titles with pronouns like "she" or "they". The user chose specific names/titles for a reason. Use pronouns sparingly and only after establishing the character name in the same scene.
${p.disableExpressions
  ? `- Write CLEAN, plain speech — NO paralinguistic tags, NO bracketed cues, NO expressions like [chuckle], [sigh], [gasp], [laugh], etc.
- Narrate in unadorned, flowing sentences only.`
  : `- Include paralinguistic tags sparingly for emotional emphasis: [sigh], [chuckle], [gasp], [laugh]
- Use them only at key emotional moments, not every scene`}

${SUB_VISUALS_SECTION}

${includeText ? `=== TEXT OVERLAY ===\n- Provide title (2-5 words) and subtitle for each scene\n- Titles should be evocative, not explanatory` : ""}

=== CHARACTER BIBLE (REQUIRED) ===
You MUST create a "characters" object defining EVERY character's EXACT visual appearance.
This ensures visual CONSISTENCY - the same person looks identical across all scenes.

For each character specify using "CharacterName_age" format if showing same person at different ages:
- GENDER (male/female) - inferred from story context, names, pronouns
- Species/type (human, dragon, unicorn, robot, etc.)
- AGE: The SPECIFIC age for this version of the character
- Physical appearance (color, build, features appropriate for age)
- Distinguishing features that remain CONSTANT (eye color, facial structure, scales color for creatures)
- Distinguishing features that CHANGE with age (size, wrinkles, body proportions)
- Clothing/accessories (period-appropriate, age-appropriate, consistent within time period)

Example:
"Hero_child": "A 7-year-old human boy with bright blue eyes, messy brown hair, freckles, wearing patched medieval peasant clothes, curious expression"
"Hero_adult": "A 30-year-old man with the SAME bright blue eyes and brown hair, now with slight stubble, wearing knight's armor, determined expression"

${PROMPT_ENGINEERING_SECTION}

${buildCoverTitleSection('"The Untold Story", "When Everything Changed", "The Final Chapter", "A Legend Rises"')}

${buildOutputFormat({
    charExamples: '"Dragon": "A majestic MALE crimson dragon with golden-flecked scales, amber eyes...",\n    "Hero_child": "A 7-year-old human boy with bright blue eyes, messy brown hair...",\n    "Hero_adult": "A 30-year-old man with the SAME bright blue eyes and brown hair..."',
    narrativeBeatExample: "opening",
    voiceoverExample: "Flowing narrative text...",
    includeTextOverlay: includeText,
    textOverlayExample: includeText ? '"title": "Evocative Headline",\n      "subtitle": "Emotional subtext"' : undefined,
  })}`;

  const user = `=== STORY IDEA ===\n${p.storyIdea}\n${inspirationSec}${toneSec}${genreSec}${charGuidance}${brandSec}`;
  return { system, user, maxTokens: 10000 };
}
