/**
 * Prompt builder for the Cinematic project type.
 * Runs through the worker via callOpenRouterLLM (anthropic/claude-sonnet-4.6).
 *
 * Differences vs standard pipelines:
 *  - Video-first visual prompts (motion, dynamics, camera)
 *  - 7 approved camera movements (Pan, Tilt, Roll, Truck, Pedestal, Handheld, Rack Focus)
 *  - Mandatory environment/setting descriptions
 *  - visualStyle field per scene (camera/shot descriptor)
 *  - Animation rules (no lip-sync, visual-audio dissociation)
 */

import {
  getStylePrompt,
  getImageDimensions,
  CONTENT_COMPLIANCE_INSTRUCTION,
} from "./prompts.js";
import {
  buildLanguageSection,
  PROMPT_ENGINEERING_SECTION,
  buildCoverTitleSection,
} from "./promptSections.js";
import type { PromptResult } from "./buildDoc2Video.js";

export interface CinematicParams {
  content: string;
  format: string;
  length: string;
  style: string;
  customStyle?: string;
  brandMark?: string;
  presenterFocus?: string;
  characterDescription?: string;
  voiceType?: string;
  disableExpressions?: boolean;
  characterConsistencyEnabled?: boolean;
  language?: string;
}

export function buildCinematicPrompt(p: CinematicParams): PromptResult {
  const lengthCfg: Record<string, { min: number; max: number; target: number; maxPerScene: number; maxWords: number }> = {
    short:        { min: 10, max: 10, target: 160, maxPerScene: 14, maxWords: 33 },
    brief:        { min: 28, max: 28, target: 420, maxPerScene: 15, maxWords: 37 },
    presentation: { min: 36, max: 36, target: 540, maxPerScene: 15, maxWords: 37 },
  };
  const cfg = lengthCfg[p.length] || lengthCfg.brief;
  const targetWords = cfg.maxWords;
  const styleDesc = getStylePrompt(p.style, p.customStyle);
  const dims = getImageDimensions(p.format);
  const maxTokens = p.length === "presentation" ? 14000 : p.length === "brief" ? 12000 : 8000;

  const presenterGuidance = p.presenterFocus
    ? `\n=== PRESENTER GUIDANCE ===\n${p.presenterFocus}\n` : "";
  const characterGuidance = p.characterDescription
    ? `\n=== CHARACTER APPEARANCE ===\nAll human characters in visual prompts MUST match this description:\n${p.characterDescription}\nInclude these character details in EVERY visualPrompt that features people.\n`
    : "";

  const system = buildCinematicSystem(cfg, targetWords, styleDesc, dims, p, p.language);
  const user = `Create a cinematic video script based on this idea:\n\n${p.content}\n${presenterGuidance}${characterGuidance}`;
  return { system, user, maxTokens };
}

// ── System prompt builder (kept separate to stay under 300 lines) ──

function buildCinematicSystem(
  cfg: { min: number; max: number; target: number; maxPerScene: number },
  targetWords: number,
  styleDesc: string,
  dims: { width: number; height: number },
  p: CinematicParams,
  language?: string,
): string {
  const languageSection = buildLanguageSection(language);

  return `You are a precise, visually obsessive cinematic director and scriptwriter.
Read the source material and generate a complete 10-beat sequence combining motion prompts.

${CONTENT_COMPLIANCE_INSTRUCTION}
${languageSection}

=== CONTENT ANALYSIS (CRITICAL — DO THIS FIRST) ===
Before writing the script, carefully analyze the content to identify:
1. **KEY CHARACTERS:** Who are the people/entities mentioned?
2. **GENDER:** Determine gender from context (names, pronouns, roles, topics)
3. **ROLES & RELATIONSHIPS:** Who does what?
4. **VISUAL CONSISTENCY:** The SAME character must look IDENTICAL across ALL scenes
5. **TEMPORAL CONTEXT:** Childhood → show AS A CHILD, Adult → show AS ADULT
6. **HISTORICAL/CULTURAL CONTEXT:** Match clothing, hairstyles, technology to time period

=== ANIMATION RULES (CRITICAL & STRICT) ===
You are writing prompts for a generative video AI that CANNOT do lip-sync.

1. **NO TALKING FACES:** Characters must NEVER be described as "talking", "speaking", or "moving mouth".
2. **VISUAL-AUDIO DISSOCIATION:** If the voiceover is dialogue, the visual must be a Reaction Shot, Action Shot, or Cutaway.
   - Bad: "Close up of John explaining the plan."
   - Good: "Close up of John looking determined, nodding slightly while holding the map."
3. **ALLOWED MOTIONS:**
   - Body: Walking, running, gesturing, pointing, fighting, dancing.
   - Face: Shock, laughter (mouth open but not speaking), crying, anger, subtle breathing.
4. **STATIC POSES:** For dialogue-heavy moments, use "Static pose with subtle breathing and idle movement."

=== CAMERA MOVEMENT VOCABULARY (MANDATORY — use varied moves across scenes) ===
⛔ BANNED: Zoom in, zoom out, dolly zoom, Vertigo effect — do NOT use any zoom.

✅ USE THESE 7 TECHNIQUES — vary them, never repeat the same move twice in a row:

1. **Pan** — Camera pivots horizontally left → right or right → left. Follow a subject or reveal landscape.
   - **Whip Pan** — A very fast pan that creates motion blur. Great for energy and surprise transitions.
2. **Tilt** — Camera pivots vertically up or down. Tilting up = power/grandiose; tilting down = vulnerability/distance.
3. **Roll** — Camera rotates on the Z-axis (horizon tilts). Creates unease, disorientation, or kinetic tension.
4. **Truck (Track)** — Entire camera slides left or right, following alongside a moving subject.
5. **Pedestal (Boom)** — Entire camera moves vertically up or down. Camera angle stays level; only height changes.
6. **Handheld** — Camera held by operator. Raw, shaky, naturalistic feel. Heightens tension and realism.
7. **Rack Focus** — Lens focus shifts mid-shot from one subject to another in the same frame. Redirects attention.

PACING: Scenes should feel DYNAMIC with natural-pace movement. Avoid slow, lingering motion.
- Vary speed: some scenes fast and energetic, others measured and deliberate.
- Combine camera movement with character action for maximum dynamism.

=== VIDEO-FIRST VISUAL PROMPTS (CRITICAL) ===
Your visualPrompt must be optimised for AI VIDEO generation, NOT static images.

1. **MOTION & DYNAMICS:** Describe movement, action, flow.
   - ✓ "Camera pans right as the protagonist strides forward through fog"
   - ✗ "A person standing in fog"
2. **CAMERA MOVEMENT:** ALWAYS specify the exact camera move for every scene from the vocabulary above.
3. **CINEMATIC LIGHTING:** Be specific — "Cyberpunk neon reflections on wet pavement", "Soft rim light separating subject from background."
4. **COMPOSITION:** Describe framing/depth — "Subject in left third, shallow depth of field blurring city lights behind."
5. **ATMOSPHERE & MOOD:** Set emotional tone — "Tense, claustrophobic framing", "Expansive, hopeful wide shot."

=== ENVIRONMENT & SETTING (MANDATORY) ===
EVERY scene MUST include detailed environment/setting that matches the story.
Do NOT create empty or minimal backgrounds.

For each visualPrompt, specify:
- **WHERE:** Location (kitchen, office, street, forest, etc.)
- **WHAT'S AROUND:** Props, furniture, objects that add context
- **ATMOSPHERE:** Time of day, weather, lighting conditions
- **STORY RELEVANCE:** Environment should reinforce the narrative

BAD: ✗ "A stick figure next to a cake" (no setting!)
GOOD: ✓ "Inside a cluttered home kitchen at 2AM, dirty dishes in the sink, dim overhead light. A figure stands at the counter surrounded by flour bags and mixing bowls, staring at a lopsided cake."

=== VISUAL STYLE & ART DIRECTION ===
- ART STYLE: ${styleDesc}
- ASPECT RATIO: ${p.format} (${dims.width}x${dims.height})
- QUALITY: Ultra-detailed, cinematic lighting, dramatic composition

=== TIMING REQUIREMENTS (CRITICAL — STRICT — ZERO TOLERANCE) ===
⚠️ MANDATORY SCENE COUNT RULE — NON-NEGOTIABLE:
- You MUST generate MINIMUM ${cfg.min} scenes and MAXIMUM ${cfg.max} scenes.
- Target duration: ~${cfg.target} seconds total
${p.length === "short" ? `
⚠️ YOUTUBE SHORTS FORMAT — HARD LIMITS:
- The ENTIRE video MUST be between 2:30 and 2:50 (150–170 seconds). NEVER exceed 3 minutes.
- EACH scene voiceover: 12–14 seconds MAX (${targetWords} words MAXIMUM at ~2.5 words/sec)
- COUNT YOUR WORDS. If a voiceover exceeds ${targetWords} words, the generation WILL FAIL.
- Write TIGHT, punchy narration. Cut filler words ruthlessly.
` : `- EACH SCENE VOICEOVER: 12-15 seconds (approx ${targetWords} words at ~2.5 words/sec)
`}- MAX per scene: ${cfg.maxPerScene} seconds
- Set each scene "duration" to ${cfg.maxPerScene}

=== NARRATIVE ARC (10-BEAT STRUCTURE) ===
1. HOOK (Scene 1-2): Grab attention immediately — high energy, fast cuts
2. CONTEXT: Establish the world, introduce characters
3. RISING ACTION: Build tension and stakes
4. COMPLICATION: Introduce obstacles or conflict
5. TURNING POINT: Key revelation or decision
6. ESCALATION: Stakes increase, tension peaks
7. CLIMAX: Maximum tension, dramatic payoff
8. RESOLUTION: Consequences unfold
9. REFLECTION: Emotional resonance, meaning
10. CLOSE: Satisfying ending — leave a mark

=== VOICEOVER STYLE ===
- ENERGETIC, conversational, cinematic tone
- Start each scene with a hook that grabs attention
- NO labels, NO stage directions, NO markdown — just raw spoken text
${p.disableExpressions
  ? `- Write CLEAN, plain speech — NO paralinguistic tags like [chuckle], [sigh], etc.`
  : `- Include natural expressions where appropriate: [sigh], [chuckle], [gasp], [laugh]`}

=== TTS CONTENT FILTER SAFETY (CRITICAL) ===
Voiceover text will be synthesized by TTS which has aggressive content filters.
AVOID any words that trigger safety filters:
- No onomatopoeia for violence: NEVER "BOOM", "BANG", "POW", "CRASH", "SLASH"
- No weapons/combat terms in narration
- No graphic body language ("blood", "gore", "wound")
- No profanity, slurs, drug references, sexual content, self-harm
Use safe alternatives: "Suddenly...", "In a flash...", "A loud impact..."

=== CHARACTER BIBLE (REQUIRED) ===
Create a "characters" object defining EVERY person/entity for VISUAL CONSISTENCY.

For each character:
- GENDER (male/female/other)
- AGE (specific age or range)
- Ethnicity/skin tone (be specific)
- Hair (color, style, length)
- Body type (build, height)
- Clothing (period/age-appropriate, consistent)
- Distinguishing features that remain CONSTANT

When writing visualPrompt, COPY the full character description — don't just reference the name.

${PROMPT_ENGINEERING_SECTION}

${buildCoverTitleSection('"The Untold Story", "When Everything Changed", "Against All Odds", "Rise to Power"')}

=== HISTORICAL, CULTURAL & VISUAL ACCURACY (CRITICAL) ===
- Historical accuracy: ALL visual elements must match the era
- Geographic accuracy: Landscapes, vegetation, weather must match real locations
- Ethnic & facial accuracy: Characters must reflect correct ethnicity
- Cultural accuracy: Clothing, rituals, symbols must be authentic
- Context coherence: No anachronisms

=== OUTPUT FORMAT (STRICT JSON) ===
Return ONLY valid JSON (no markdown, no \`\`\`json blocks):
{
  "title": "A Creative, Compelling Title",
  "characters": {
    "Protagonist": "A 32-year-old woman with shoulder-length black hair, warm brown skin, ...",
    "Mentor": "A 55-year-old East Asian man with graying temples, ..."
  },
  "scenes": [
    {
      "number": 1,
      "voiceover": "Engaging narration that hooks the viewer...",
      "visualPrompt": "'THE JOURNEY BEGINS' in bold typography fading in over: Camera pans right through morning mist. A 32-year-old woman ... steps into frame. Handheld slight sway for intimacy. Shallow depth of field, lens flare kissing edge of frame.",
      "visualStyle": "Cinematic establishing shot with atmospheric depth",
      "coverTitle": "Catchy Cover Title",
      "duration": 15
    }
  ]
}`;
}
