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
  buildBrandSection,
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
  /** Autopost-only — see SmartFlowParams for rationale. */
  topic?: string;
  /** Autopost-only — see SmartFlowParams for rationale. */
  previousTopics?: string[];
}

export function buildCinematicPrompt(p: CinematicParams): PromptResult {
  const lengthCfg: Record<string, { min: number; max: number; target: number; maxPerScene: number; maxWords: number }> = {
    short:        { min: 15, max: 15, target: 165, maxPerScene: 11, maxWords: 28 },
    brief:        { min: 28, max: 28, target: 308, maxPerScene: 11, maxWords: 28 },
    presentation: { min: 36, max: 36, target: 396, maxPerScene: 11, maxWords: 28 },
  };
  const cfg = lengthCfg[p.length] || lengthCfg.brief;
  const targetWords = cfg.maxWords;
  const styleDesc = getStylePrompt(p.style, p.customStyle);
  const dims = getImageDimensions(p.format);
  const maxTokens = p.length === "presentation" ? 24000 : p.length === "brief" ? 16000 : 12000;

  const presenterGuidance = p.presenterFocus
    ? `\n=== PRESENTER GUIDANCE ===\n${p.presenterFocus}\n` : "";
  const characterGuidance = p.characterDescription
    ? `\n=== USER-SPECIFIED CHARACTER APPEARANCE (GROUND TRUTH — NON-NEGOTIABLE) ===\n${p.characterDescription}\n\n` +
      `THIS IS THE CREATOR'S EXPLICIT INPUT AND IT OVERRIDES ANYTHING YOU INFER FROM THE CONTENT.\n` +
      `MANDATORY RULES:\n` +
      `1. Your "characters" object MUST be built FROM this description — copy the exact traits (species, skin tone, hair, clothing, build, age, distinguishing features) into every matching character entry.\n` +
      `2. EVERY visualPrompt that features a character MUST include these appearance details verbatim — do NOT summarize, do NOT paraphrase, do NOT substitute.\n` +
      `3. Do NOT invent a different look. Do NOT default to a generic protagonist. Do NOT change ethnicity, species, or key features.\n` +
      `4. If the description conflicts with what "feels right" for the content, THIS description wins.\n`
    : "";

  const brandSec = buildBrandSection(p.brandMark);
  let system = buildCinematicSystem(cfg, targetWords, styleDesc, dims, p, p.language);
  // Inject the user's character description into the SYSTEM prompt too so the LLM
  // treats it as authoritative ground truth before reading the content, not as a
  // soft suggestion tacked onto the user message.
  if (characterGuidance) {
    system += `\n${characterGuidance}`;
  }
  // Truncate content to 10,000 chars to prevent API timeouts on massive inputs
  const truncatedContent = p.content.length > 10000 ? p.content.substring(0, 10000) + "\n\n[Content truncated — focus on the key themes above]" : p.content;

  // Autopost: same Autonomux-style topic + previousTopics injection
  // as the smartflow / doc2video builders.
  const exclusionBlock = p.previousTopics && p.previousTopics.length > 0
    ? `\n=== DO NOT REPEAT (recently covered topics) ===\n${p.previousTopics.map((t, i) => `${i + 1}. "${t}"`).join("\n")}\nThe video MUST cover a DIFFERENT angle from every entry above.\n`
    : "";

  const user = p.topic
    ? `=== EXACT TOPIC FOR THIS VIDEO ===
"${p.topic}"

This quoted phrase IS the subject of the cinematic. Use the FULL phrase. Do not abbreviate to a single keyword. Do not generalize.
${exclusionBlock}
=== ADDITIONAL CONTEXT (tone, style, audience — NOT subject) ===
${truncatedContent}
${presenterGuidance}${characterGuidance}${brandSec}`
    : `Create a cinematic video script based on this idea:\n\n${truncatedContent}\n${presenterGuidance}${characterGuidance}${brandSec}`;
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

  return `You are a DYNAMIC video script writer creating engaging, narrative-driven content.

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

1. **NO LIP-SYNC IN VISUALS (this applies to visualPrompt ONLY, NOT voiceover):**
   - Characters in visualPrompt must NEVER be described as "talking", "speaking", "explaining", or "moving mouth".
   - The video AI CANNOT animate lip-sync, so visual prompts must show ACTION, not talking.
   - Characters CAN interact through gestures, body language, and physical contact.
   - The VOICEOVER can be in any perspective the user requests (1st person, 3rd person, etc.) — this rule only restricts the visual descriptions.
2. **AUDIO-VISUAL ALIGNMENT (MANDATORY — ZERO TOLERANCE FOR DRIFT):**
   Scene N's visualPrompt MUST literally depict the SUBJECT and EVENT named in scene N's voiceover, IN THAT SAME SCENE — never one or two scenes later.
   The voiceover and visual are a TIGHTLY COUPLED PAIR: the audio narrates what is happening, the visual SHOWS that exact thing happening. They share the same subject, the same event, the same moment in time.
   - If voiceover says "Argentina came in a boat" → visualPrompt MUST show the boat arriving at an Argentine port with Argentine flags / immigrants disembarking — IN THIS SCENE. Do NOT save the boat shot for a later scene.
   - If voiceover says "the factory caught fire in 1943" → visualPrompt MUST show the burning factory in 1943 — IN THIS SCENE.
   - The ONLY thing the visual omits from the audio is anyone "talking" (the video AI can't lip-sync) — instead show the subject acting, the event unfolding, or the consequence playing out.
   - Bad: voiceover "Argentina came in a boat" + visualPrompt "A determined man stares out a window" (subject mismatch — the boat never appears in this scene).
   - Bad: voiceover "John explains the plan" + visualPrompt "Close up of John explaining the plan." (depicts talking).
   - Good: voiceover "John explains the plan" + visualPrompt "John leans over a war-room map, finger tracing a route across the terrain, his crew gathered close watching the line he draws, lantern light flickering on their faces."
   - Good: voiceover "Argentina came in a boat" + visualPrompt "A weathered cargo ship glides into a 1900s Buenos Aires harbor at dawn, Argentine flag snapping in the wind from the stern, immigrants crowded along the rails clutching suitcases as dockworkers haul ropes. Camera: Truck left, following the ship's hull along the pier."
3. **FACIAL EXPRESSIONS (MATCH THE MOOD — BE CREATIVE & DETAILED):**
   - Characters MUST have rich, expressive faces in every scene — never blank or neutral.
   - Match the scene emotion: curiosity (head tilted, brow raised), determination (jaw set, eyes focused), joy (beaming smile, eyes crinkling), surprise (eyes wide, mouth agape), concern (furrowed brow, pursed lips), awe (wide eyes, slight open mouth), hope (soft smile, upward gaze).
   - Combine expressions with body language: "She clutches the letter to her chest, eyes glistening with unshed tears, chin trembling."
   - Expressions MUST match the emotional tone of the voiceover — don't default to angry or fearful faces.
4. **MOTION & ACTION (NEVER STATIC):**
   - Every scene must have DYNAMIC movement — characters walking, running, gesturing, reacting, reaching, turning.
   - No static poses. No standing still. No "character stands in front of..." without action.
   - Combine character action with environment action: "She runs through the rain-soaked alley as neon signs flicker and steam rises from grates."
   - All motion at FAST, ENERGETIC, REAL-TIME speed — NEVER slow motion, NEVER sluggish, NEVER lethargic. Every movement should feel ALIVE and URGENT.

=== BODY & CONTENT SAFETY (STRICT — ZERO TOLERANCE) ===
⛔ BANNED CONTENT — NEVER include in any visualPrompt:
- NO nudity, NO exposed buttocks, NO exposed breasts, NO naked body parts
- NO sexually suggestive poses or clothing (no lingerie, no bikinis unless explicitly beach context)
- NO weird body transformations, NO body contortions, NO limbs bending unnaturally
- NO faces melting, NO bodies morphing into other bodies or objects
- Characters must always have anatomically correct proportions — no extra limbs, no stretched necks, no distorted faces
- All characters must be FULLY CLOTHED in context-appropriate attire at all times

=== TEMPORAL CONSISTENCY & PHYSICS (ZERO TOLERANCE) ===
The video AI tends to morph appearance and break physics across frames.
Keep these rules in MIND while writing each scene, but DO NOT copy
this list into the visualPrompt — that text gets passed to the still-
image generator (gpt-image-2, 4000-char prompt cap) and bloats the
prompt past the limit, returning E1004 "Invalid input parameters".
The video-side worker (handleCinematicVideo.ts) already appends a
condensed motion-guardrail trailer to the Seedance prompt, so these
constraints are enforced at render time. Use them HERE only to shape
the scene description (e.g. don't write "Mary swaps her coat for a
dress mid-scene"; that's a NEW scene).

Internal checklist (do not write into visualPrompt):
1. OUTFIT LOCK — same clothing/hair from start to end of a scene.
2. NO CLIPPING THROUGH SOLID OBJECTS — characters go around, not through.
3. HEAD-BODY ALIGNMENT — face never turned >90° from the torso.
4. ANATOMICAL JOINT LIMITS — limbs bend only at real joints, natural directions.
5. SMOOTH CAMERA & MOTION — no within-clip jumps; energy ≠ choppy motion.
6. SMOOTH SCENE TRANSITIONS — end pose/framing/light flows into next scene.

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

PACING: Scenes MUST feel DYNAMIC, FAST, and ENERGETIC — real-time human speed, NEVER slow motion, NEVER sluggish.
⛔ BANNED PACING: slow, slow motion, slomo, sluggish, lethargic, gentle, drifting, floating, crawling, glacial
✅ REQUIRED PACING: brisk, swift, energetic, urgent, punchy, snappy, lively, rapid
- Camera movements should be CONFIDENT and PURPOSEFUL — not lazy or drifting
- Combine FAST camera movement with ACTIVE character motion for maximum dynamism
- Mix and combine multiple camera techniques within a single scene when it enhances the storytelling

=== SPECIAL EFFECTS & VISUAL DYNAMICS (CRITICAL) ===
Make every scene visually SPECTACULAR. Include contextual special effects that match the story:
- **ENVIRONMENTAL FX:** Wind blowing hair/clothes, rain splashing, dust particles in light beams, fog rolling in
- **DRAMATIC FX:** Explosions, fire, sparks, shattering glass, lightning strikes — when the story calls for it
- **ATMOSPHERIC FX:** Lens flares, light rays, aurora, stars twinkling, sun glare, neon reflections
- **PARTICLE FX:** Embers floating, snow falling, leaves swirling, smoke drifting, confetti
- **ENERGY FX:** Glowing auras, shockwaves, motion blur on fast action, speed lines

DO NOT hold back — if the scene calls for drama, go BIG. Explosions, storms, cosmic visuals.
The goal is to make every frame feel like a blockbuster movie or a viral social media clip.

=== VIDEO-FIRST VISUAL PROMPTS (CRITICAL) ===
Your visualPrompt must be optimised for AI VIDEO generation, NOT static images.
Every visualPrompt MUST be rich, detailed, and cinematic. Be CREATIVE. Think like a blockbuster movie director.

1. **MOTION & DYNAMICS:** Describe movement, action, flow — NEVER describe still/frozen scenes.
   - ✓ "Camera trucks right as the protagonist strides forward through fog, coat billowing violently in the wind, her hand reaching out to grab the rusted gate while sparks fly from the streetlamp above. Camera: Truck right to left, following subject."
   - ✗ "A person standing in fog"
2. **CAMERA MOVEMENT (MANDATORY — LAST LINE OF EVERY visualPrompt):**
   EVERY visualPrompt MUST end with an explicit camera motion directive on its own line:
   "Camera: [Motion Type] [direction/detail]"
   Examples:
   - "Camera: Pan left to right, following the subject across the room."
   - "Camera: Tilt upward, revealing the towering cathedral."
   - "Camera: Handheld, subtle shake, tracking subject through crowd."
   - "Camera: Rack Focus from foreground candle to background figure."
   - "Camera: Truck left, gliding alongside as character walks."
   - "Camera: Pedestal up, rising to reveal city skyline."
   - "Camera: Roll slight clockwise, creating tension."
   Pick from the 7 approved techniques. Vary them — never use the same motion two scenes in a row.
   Be specific about DIRECTION (left/right/up/down) and SPEED (slow/steady/fast/whip).
3. **CINEMATIC LIGHTING:** Be specific — "Cyberpunk neon reflections on wet pavement", "Soft rim light separating subject from background."
4. **COMPOSITION:** Describe framing/depth — "Subject in left third, shallow depth of field blurring city lights behind."
5. **ATMOSPHERE & MOOD:** Set emotional tone — "Tense, claustrophobic framing", "Expansive, hopeful wide shot."
6. **SPECIAL EFFECTS:** Include relevant VFX per the section above — particles, weather, energy, environmental FX.
7. **CHARACTER IN EVERY SCENE:** Include the FULL character description (appearance, clothing, features) in EVERY visualPrompt. Do NOT just say "the protagonist" — describe them EVERY time.
8. **STYLE CONSISTENCY:** Every visualPrompt must FIT the art style described in the VISUAL STYLE section below — but DO NOT copy the full style description into the visualPrompt itself. The image renderer appends the full style block automatically; embedding it again duplicates text and clutters the Editor's prompt UI. Just describe the scene-specific content (subject, action, framing, lighting, mood) in plain language.
9. **TEXT & LANGUAGE:** Any text, titles, signs, or written content visible in the scene MUST be in the SAME language as the voiceover.${p.language ? ` All visible text must be in ${p.language === "fr" ? "French" : p.language === "ht" ? "Haitian Creole" : "English"}.` : ""}
10. **SCENE TRANSITIONS (SECONDARY — never override audio-visual alignment):** Each scene's video will morph into the NEXT scene's image. AFTER you've nailed the subject of scene N (which MUST match scene N's voiceover per rule #2), THEN polish the END state so it bridges naturally into the START of scene N+1 via matching colors, compositions, or motions. Continuity is a finishing touch — it must NEVER be used as an excuse to delay a subject from voiceover[N] into visualPrompt[N+1] or [N+2]. If the voiceover names a subject in this scene, the visual shows that subject in THIS scene, even if the bridge to the next scene is rougher.

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

=== TIMING REQUIREMENTS (CRITICAL) ===
- You MUST generate EXACTLY ${cfg.min} scenes.
- Target duration: ~${cfg.target} seconds total.
- EACH scene voiceover targets ~${targetWords} words (≈ ${cfg.maxPerScene}s at 2.5 words/sec). HARD range: ${targetWords - 2} to ${targetWords + 3} words. Anything outside this range desyncs the audio from the visual — the voice ends up describing what's about to be shown or what was just shown, not what's on screen now.
- **WRITE SENTENCES THAT FIT THE BUDGET.** Plan the sentence length BEFORE writing it. If a thought won't end cleanly within ${targetWords + 3} words, write a SHORTER thought instead — split the longer idea across two scenes. Do NOT extend a scene past ${targetWords + 3} just to finish a long sentence; the audio will overrun the visual and the timing breaks.
- EVERY voiceover MUST end with a sentence terminator: . ! or ?  — never with "and", "is", "the", "but", a comma, an em dash, or any unfinished clause. If you're approaching the word ceiling and still mid-clause, the sentence you started was too long — rewrite the WHOLE scene with a shorter sentence that lands cleanly under ${targetWords + 3}.
- Read each voiceover back to yourself: does it sound like a complete thought AND is it within the hard range? If not, rewrite it.
- Do NOT write short, clipped scenes either. Aim for the ${targetWords}-word target with flowing, complete sentences that fit the budget.
- Set each scene "duration" to ${cfg.maxPerScene}.

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
- DELIVERY GUARDRAILS (hard "do-not", read these twice):
  • NO whisper, NO ASMR, NO breathy intimate tone, NO emphatic shouting
  • NO dramatic theatrical delivery, NO movie-trailer narration, NO documentary-narrator gravitas
  • NO suspenseful pacing, NO ominous build-up, NO mysterious hush, NO "let me tell you a secret" energy
  • NO performative sighs, NO pregnant pauses, NO "..." cliffhanger beats, NO whispered punchlines
- IGNORE THE TOPIC'S VIBE when choosing tone. Even if the content is heavy / dark / supernatural / occult, read it like you're explaining it to a friend over coffee — not like a paranormal podcast or a Netflix true-crime narrator. Topic can be heavy; DELIVERY stays light, casual, friendly.
- Reference voice: a smart girlfriend explaining over brunch — confident, curious, warm, occasionally funny, never solemn. Not a wise mystic. Not a horror narrator. Not a yoga teacher.
- Avoid paralinguistic tags entirely: no [sigh], [whisper], [gasp], [chuckle], [dramatic pause], [ominous]. Emphasis comes from word choice and rhythm, not vocal theatrics.
- The FIRST scene hooks the audience. Every scene AFTER that BUILDS on what came before
- Vary pacing: some scenes push forward, some pause to reflect, some escalate — like a real speaker
- NO labels, NO stage directions, NO markdown — just raw spoken text
- **PRESERVE THE USER'S EXACT TERMINOLOGY**: If the user uses specific names, titles, or terms, keep them throughout — do NOT replace with generic pronouns
${p.disableExpressions
  ? `- Write CLEAN, plain speech — NO paralinguistic tags like [chuckle], [sigh], etc.`
  : `- Include paralinguistic tags sparingly for emotional emphasis: [sigh], [chuckle], [gasp], [laugh]
- Use them only at key emotional moments, not every scene`}

=== TTS CONTENT FILTER SAFETY (CRITICAL) ===
Voiceover text will be synthesized by TTS which has aggressive content filters.
AVOID any words that trigger safety filters:
- No onomatopoeia for violence: NEVER "BOOM", "BANG", "POW", "CRASH", "SLASH"
- No weapons/combat terms in narration
- No graphic body language ("blood", "gore", "wound")
- No profanity, slurs, drug references, sexual content, self-harm
Use safe alternatives: "Suddenly...", "In a flash...", "A loud impact..."

=== CHARACTER BIBLE (REQUIRED — ZERO TOLERANCE FOR INACCURACY) ===
Create a "characters" object defining EVERY person/entity for VISUAL CONSISTENCY.

⚠️ IF RESEARCH DATA IS PROVIDED ABOVE: You MUST copy the EXACT physical descriptions from the research.
DO NOT invent appearances. DO NOT default to generic descriptions. DO NOT whitewash or change ethnicity.
If the research says "Kylian Mbappé — dark brown skin, close-cropped black hair, athletic build, wearing blue France jersey #10" then your character description MUST say EXACTLY that.

For each character:
- GENDER (verified — DO NOT assume)
- AGE (specific age or range — look it up for real people)
- RACE & SKIN TONE (be SPECIFIC — "warm dark brown skin" not "dark skin")
- ETHNICITY (be SPECIFIC — "Haitian", "Moroccan", "Brazilian" etc.)
- Hair (color, style, length — verified for real people)
- Facial features (be detailed — "strong jawline, high cheekbones, full lips")
- Body type (build, height — verified for athletes/celebrities)
- Clothing (EXACT for the specific event/context — jersey colors, numbers, period-accurate)
- Distinguishing features that remain CONSTANT across all scenes

⛔ For REAL PEOPLE (celebrities, athletes, politicians, historical figures):
   You MUST describe what they ACTUALLY look like. Not a generic placeholder.
   If you don't know, USE THE RESEARCH DATA. If no research, describe them accurately.
   NEVER depict a Black person as white, an Asian person as European, etc.

⛔ CHARACTER CONSISTENCY ENFORCEMENT — NON-NEGOTIABLE:
When writing visualPrompt, you MUST COPY-PASTE the EXACT character description from the "characters" object into EVERY scene where that character appears. Do NOT paraphrase, abbreviate, or "vary" the description.

THE FOLLOWING MUST BE IDENTICAL IN EVERY SCENE FOR THE SAME CHARACTER:
- EXACT same hair color, style, and length (no switching from braids to straight hair)
- EXACT same clothing and outfit (no random wardrobe changes between scenes)
- EXACT same skin tone description
- EXACT same body type and distinguishing features

If a character wears a "navy blue hoodie and white sneakers" in scene 1, they MUST wear "navy blue hoodie and white sneakers" in ALL scenes unless the story EXPLICITLY requires a change (e.g. "she changed into her uniform").

BAD: Scene 1: "woman with curly brown hair in a red dress" → Scene 5: "woman with straight dark hair in jeans"
GOOD: Scene 1: "woman with curly brown hair in a red dress" → Scene 5: "woman with curly brown hair in a red dress, now running through the park"

${p.characterConsistencyEnabled ? `=== STUDIO CHARACTER LOCK (ACTIVE) ===
⚠️ This generation uses STUDIO-grade character consistency enforcement.
In EVERY scene's visualPrompt, copy the character's EXACT physical description from the "characters" object — verbatim, not paraphrased.
Same skin tone. Same hair color and style. Same clothing. Same build. Every scene. No exceptions.

` : ""}${PROMPT_ENGINEERING_SECTION}

${buildCoverTitleSection('"The Untold Story", "When Everything Changed", "Against All Odds", "Rise to Power"', styleDesc)}

=== HISTORICAL, CULTURAL & VISUAL ACCURACY (CRITICAL — ZERO TOLERANCE) ===
⛔ THIS IS THE #1 PRIORITY. Getting appearances wrong is WORSE than a bad script.
- Historical accuracy: ALL visual elements must match the era — no anachronisms
- Geographic accuracy: Landscapes, vegetation, weather must match real locations
- Ethnic & facial accuracy: Characters MUST reflect their CORRECT ethnicity, skin color, and features
  - A Black man MUST be depicted as Black. An Asian woman MUST be depicted as Asian.
  - NEVER default to white/European features for any character unless they ARE white/European.
  - For real people: look at the RESEARCH DATA and describe their ACTUAL appearance.
- Cultural accuracy: Clothing, hairstyles, rituals, symbols must be authentic to the culture
- Sports accuracy: Jersey colors, team logos, stadium details must match the SPECIFIC game/event
- Context coherence: No anachronisms — if it's 1960, no smartphones; if it's ancient Rome, no jeans

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
      "visualPrompt": "'THE JOURNEY BEGINS' in bold typography fading in over morning mist. A 32-year-old woman with shoulder-length black hair steps into frame, coat billowing. Shallow depth of field, lens flare kissing edge of frame. Warm golden hour light.\nCamera: Pan right to left, steady pace, revealing the landscape as the subject walks into frame.",
      "visualStyle": "Cinematic establishing shot with atmospheric depth",
      "coverTitle": "Catchy Cover Title",
      "duration": 11
    }
  ]
}`;
}
