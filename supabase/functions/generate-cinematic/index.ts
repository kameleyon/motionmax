import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decode as base64Decode, encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import {
  generateSceneAudio as sharedGenerateSceneAudio,
  isHaitianCreole,
  pcmToWav,
  type AudioEngineConfig,
  type StorageStrategy,
} from "../_shared/audioEngine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type Phase = "script" | "audio" | "images" | "video" | "finalize" | "image-edit" | "image-regen";

interface CinematicRequest {
  phase?: Phase;

  // Script phase inputs
  content?: string;
  format?: "landscape" | "portrait" | "square";
  length?: string;
  style?: string;
  customStyle?: string;
  brandMark?: string;
  presenterFocus?: string;
  characterDescription?: string;
  disableExpressions?: boolean;
  characterConsistencyEnabled?: boolean;
  voiceType?: "standard" | "custom";
  voiceId?: string;
  voiceName?: string;

  // Subsequent phases inputs
  projectId?: string;
  generationId?: string;
  sceneIndex?: number;
  imageModification?: string;
}

interface Scene {
  number: number;
  voiceover: string;
  visualPrompt: string;
  visualStyle: string;
  duration: number;
  audioUrl?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioPredictionId?: string;
  videoPredictionId?: string;
  videoRetryCount?: number;
  videoRetryAfter?: string;
  videoProvider?: "replicate" | "hypereal";
  videoModel?: string;
}

const REPLICATE_MODELS_URL = "https://api.replicate.com/v1/models";
const REPLICATE_PREDICTIONS_URL = "https://api.replicate.com/v1/predictions";

// Use chatterbox-turbo with voice parameter (Marisol/Ethan) like the main pipeline
const CHATTERBOX_TURBO_URL = "https://api.replicate.com/v1/models/resemble-ai/chatterbox-turbo/predictions";
const SEEDANCE_VIDEO_MODEL = "bytedance/seedance-1-pro-fast";
const GROK_VIDEO_MODEL = "xai/grok-imagine-video";

// Nano Banana models for image generation (Replicate)
const NANO_BANANA_MODEL = "google/nano-banana-2";

// ============= STYLE PROMPTS (from generate-video/index.ts) =============
const STYLE_PROMPTS: Record<string, string> = {
  minimalist: `Minimalist illustration using thin monoline black line art. Clean Scandinavian / modern icon vibe. Large areas of white negative space. Muted pastel palette (sage green, dusty teal, soft gray-blue, warm mustard) with flat fills only (no gradients). Centered composition, crisp edges, airy spacing, high resolution.`,

  doodle: `Urban Minimalist Doodle style. Creative, Dynamic, and Catchy Flat 2D vector illustration with indie comic aesthetic. Make the artwork detailed, highly dynamic, catchy and captivating, and filling up the entire page. Add Words to illustrate the artwork. LINE WORK: Bold, consistent-weight black outlines (monoline) that feel hand-drawn but clean, with slightly rounded terminals for a friendly, approachable feel. COLOR PALETTE: Muted Primary tones—desaturated dusty reds, sage greens, mustard yellows, and slate blues—set against a warm, textured background. CHARACTER DESIGN: Object-Head surrealism with symbolic objects creating an instant iconographic look that is relatable yet stylized. TEXTURING: Subtle Lo-Fi distressing with light paper grain, tiny ink flecks, and occasional print misalignments where color doesn't perfectly hit the line. COMPOSITION: Centralized and Floating—main subject grounded surrounded by a halo of smaller floating icons representing the theme without cluttering. Technical style: Flat 2D Vector Illustration, Indie Comic Aesthetic. Vibe: Lo-fi, Chill, Entrepreneurial, Whimsical. Influences: Modern editorial illustration, 90s streetwear graphics, and Lofi Girl aesthetics.`,

  stick: `Hand-drawn stick figure comic style. Crude, expressive black marker lines on a pure white. Extremely simple character designs (circles for heads, single lines for limbs). No fill colors—strictly black and white line art. Focus on humor and clarity. Rough, sketchy aesthetic similar to 'XKCD' or 'Wait But Why'. Imperfect circles and wobbly lines to emphasize the handmade, napkin-sketch quality. The background MUST be solid pure white (#FFFFFF)—just clean solid white.`,

  realistic: `Photorealistic cinematic photography. 4K UHD, HDR, 8k resolution. Shot on 35mm lens with shallow depth of field (bokeh) to isolate subjects. Hyper-realistic textures, dramatic studio lighting with rim lights. Natural skin tones and accurate material physics. Look of high-end stock photography or a Netflix documentary. Sharp focus, rich contrast, and true-to-life color grading. Unreal Engine 5 render quality.`,

  anime: `Expressive Modern Manga-Style Sketchbook. An expressive modern manga-style sketchbook illustration. Anatomy: Large-eye expressive anime/manga influence focusing on high emotional impact and kawaii but relatable proportions. Line Work: Very loose, visible rough sketch lines—looks like a final drawing made over a messy pencil draft. Coloring: Natural tones with focus on skin-glow, painterly approach with visible thick brush strokes. Vibe: Cozy, chaotic, and sentimental slice-of-life moments. Features loose sketchy digital pencil lines and painterly slice-of-life aesthetic. High-detail facial expressions with large emotive eyes. Visible brush strokes. Set in detailed, slightly messy environment that feels lived-in. Cozy, relatable, and artistically sophisticated.`,

  "3D Pix": `Cinematic 3D Animation. A stunning 3D cinematic animation-style render in the aesthetic of modern Disney-Pixar films. Surface Geometry: Squash and Stretch—appealing rounded shapes with soft exaggerated features, avoiding sharp angles unless part of mechanical design. Material Science: Subsurface Scattering—that Disney glow where light slightly penetrates the surface like real skin or wax, textures are stylized realism with soft fur, knit fabrics, or polished plastic. Lighting Design: Three-Point Cinematic—strong key light, soft fill light to eliminate harsh shadows, bright rim light (backlight) creating glowing silhouette separating from background. Eyes: The Soul Focal Point—large, highly detailed eyes with realistic specular highlights and deep iris colors making character feel sentient and emotive. Atmosphere: Volumetric Depth—light fog, dust motes, or god rays creating sense of physical space, background has soft bokeh blur keeping focus on subject. High-detail textures, expressive large eyes, soft rounded features. Vibrant saturated colors with high-end subsurface scattering on all surfaces. Rendered in 8k using Octane, shallow depth of field, whimsical softly blurred background. Masterpiece quality, charming, tactile, and highly emotive.`,

  claymation: `Handcrafted Digital Clay. A high-detail 3D claymation-style render. Material Texture: Matte & Tactile—surfaces must show subtle, realistic imperfections like tiny thumbprints, slight molding creases, and a soft matte finish that mimics polymer clay (like Sculpey or Fimo). Lighting: Miniature Macro Lighting—soft, high-contrast studio lighting that makes the subject look like a small physical object, includes Rim Lighting to make the edges glow and deep, soft-edge shadows. Proportions: Chunky & Appealing—thick, rounded limbs and exaggerated squashy features, avoid any sharp digital edges, everything should look like it was rolled between two palms. Atmosphere: Depth of Field—heavy background blur (bokeh) essential to sell the small toy scale, making the subject pop as the central focus. Color Palette: Saturated & Playful—bold, solid primary colors that look like they came straight out of a clay pack, avoiding complex gradients. 8k resolution, Octane Render, masterpiece quality.`,

  sketch: `Emphasize the paper cutout effect with a strong dark 3D backdrop shadow. Hand-drawn stick figure comic style, but with a polished, clean digital finish. Smooth, expressive black marker lines on pure white. Extremely simple character designs (perfect single-stroke circles for heads, solid single lines for limbs). Avoid sketchy, wobbly, or overlapping rough lines; use confident, clean monoline strokes instead. Strictly black and white line art. High contrast black and white ONLY, no other color. Focus on humor and clarity while maintaining a neat professional aesthetic. Crucial Effect: Apply strong "paper cutout" 3D drop shadows behind the characters and objects to make them pop off the page like a diorama. Ensure natural orientation and correct anatomy (two arms, two legs). Make it detailed, highly creative, extremely expressive, and dynamic, while keeping character consistency. Include environment or setting of the scene so the user can see where the scene is happening. Make on a plain solid white background. ANIMATION RULES (CRITICAL): NO lip-sync talking animation - characters should NOT move their mouths as if speaking. Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry. Body movement IS allowed: walking, running, gesturing, pointing, reacting. Environment animation IS allowed: wind, particles, camera movement, lighting changes. Static poses with subtle breathing/idle movement are preferred for dialogue scenes. Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement.`,

  caricature: `Humorous caricature illustration inspired by the visual aesthetic of MAD Magazine cover art — bold, dynamic, richly painted with energetic brushwork. Highly exaggerated facial features: oversized heads, giant expressive eyes, huge noses, rubbery lips, tiny bodies. Vivid, saturated color palette with loose oil-painting brushstrokes and strong ink outlines. Characters are dramatic, larger-than-life, and bursting with personality. Dynamic cinematic compositions with expressive poses and exaggerated reactions. The painterly style has visible confident brushwork, vibrant shadows, and punchy highlights. CRITICAL: Do NOT include the MAD magazine logo or title text anywhere in the image. No "MAD" lettering, no magazine masthead, no title banner.`,

  moody: `Moody monochrome indie comic illustration in black, white, and grays. Thick clean outlines with hand-inked crosshatching and scratchy pen texture for shading. Slightly uneven line quality like traditional ink on paper. Cute-but-unsettling character design: oversized head, huge simple eyes empty, tiny mouth, minimal nose; small body with simplified hands. Cinematic centered framing, quiet tension, lots of flat mid-gray tones. Subtle paper grain and faint smudges. Background is minimal but grounded with simple interior props drawn in the same inked style. Overall vibe: moody, not happy, melancholic, eerie, storybook graphic novel panel, high contrast, no color. 2D ink drawing.`,

  storybook: `Whimsical storybook hand-drawn ink style. Hand-drawn black ink outlines with visible rough sketch construction lines, slightly uneven strokes, and occasional line overlap (imperfect but intentional). Bold vivid natural color palette. Crosshatching and scribbly pen shading for depth and texture, especially in shadows and on fabric folds. Watercolor + gouache-like washes: layered, semi-opaque paint with soft gradients. Edges slightly loose (not crisp), with gentle paint bleed and dry-brush texture in places. Cartoon-proportioned character design: slightly exaggerated features (large eyes, long limbs, expressive faces), but grounded in believable anatomy and posture. Background detailed but painterly: textured walls, props with sketchy detail, and atmospheric depth. Subtle grain + ink flecks for a handmade print feel. Cinematic framing, shallow depth cues, soft focus in far background. Editorial illustration / indie animation concept art aesthetic. Charming, cozy, slightly messy, richly textured, high detail, UHD. No 3D render, no clean vector, no flat icon style, no anime/manga linework, no glossy neon gradients, no photorealism.`,

  crayon: `Cute childlike crayon illustration on clean white paper background. Waxy crayon / oil pastel scribble texture with visible stroke marks and uneven fill (messy on purpose). Simple rounded shapes, thick hand-drawn outlines, minimal details, playful proportions (big head, small body). Bright limited palette like orange + blue + yellow, rough shading and light smudges like real crayons on paper. Simple cheerful scene, lots of white space, friendly smiley faces. Looks like kindergarten drawing scanned into computer. High resolution. No vector, no clean digital painting, no 3D, no realism, no gradients, no sharp edges.`,

  chalkboard: `A hand-drawn chalkboard illustration style characterized by voluntarily imperfect, organic lines that capture the authentic vibe of human handwriting. Unlike rigid digital art, the strokes feature subtle wobbles, varying pressure, and natural endpoints, mimicking the tactile feel of chalk held by a steady hand. The background is a deep, dark slate grey, almost black, with a very subtle, fine-grain slate texture that suggests a fresh, clean surface rather than a dusty one. The line work features crisp, monoline chalk outlines that possess the dry, slightly grainy texture of real chalk and are drawn with authentic vibe of hand-drawing, yet ensuring a confident and legible look. The color palette utilizes high-contrast stark white. The rendering is flat and illustrative, with solid chalk fills textured via diagonal hatching or stippling to let the dark background show through slightly, creating a vibe that is smart, academic, and hand-crafted yet thoroughly professional. No other colors than white.`,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ============= HAITIAN CREOLE DETECTION =============
function isHaitianCreole(text: string): boolean {
  const lowerText = text.toLowerCase();
  const creoleIndicators = [
    "mwen",
    "ou",
    "li",
    "nou",
    "yo",
    "sa",
    "ki",
    "nan",
    "pou",
    "ak",
    "pa",
    "se",
    "te",
    "ap",
    "gen",
    "fè",
    "di",
    "ale",
    "vin",
    "bay",
    "konnen",
    "wè",
    "pran",
    "mete",
    "vle",
    "kapab",
    "dwe",
    "bezwen",
    "tankou",
    "paske",
    "men",
    "lè",
    "si",
    "kote",
    "kouman",
    "poukisa",
    "anpil",
    "tout",
    "chak",
    "yon",
    "de",
    "twa",
    "kat",
    "senk",
    "ayiti",
    "kreyòl",
    "kreyol",
    "bondye",
    "mèsi",
    "bonjou",
    "bonswa",
    "kijan",
    "eske",
    "kounye",
    "toujou",
    "jamè",
    "anvan",
    "apre",
    "t ap",
    "pral",
    "ta",
  ];

  let matchCount = 0;
  for (const indicator of creoleIndicators) {
    const regex = new RegExp(`\\b${indicator}\\b`, "gi");
    if (regex.test(lowerText)) matchCount++;
  }

  return matchCount >= 3;
}

// ============= PCM TO WAV CONVERSION =============
function pcmToWav(
  pcmData: Uint8Array,
  sampleRate: number = 24000,
  numChannels: number = 1,
  bitsPerSample: number = 16,
): Uint8Array {
  const audioFormat = bitsPerSample === 32 ? 3 : 1;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint8(0, 0x52);
  view.setUint8(1, 0x49);
  view.setUint8(2, 0x46);
  view.setUint8(3, 0x46);
  view.setUint32(4, totalSize - 8, true);
  view.setUint8(8, 0x57);
  view.setUint8(9, 0x41);
  view.setUint8(10, 0x56);
  view.setUint8(11, 0x45);

  // fmt subchunk
  view.setUint8(12, 0x66);
  view.setUint8(13, 0x6d);
  view.setUint8(14, 0x74);
  view.setUint8(15, 0x20);
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  view.setUint8(36, 0x64);
  view.setUint8(37, 0x61);
  view.setUint8(38, 0x74);
  view.setUint8(39, 0x61);
  view.setUint32(40, dataSize, true);

  const result = new Uint8Array(buffer);
  result.set(pcmData, headerSize);
  return result;
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sanitizeBearer(authHeader: string) {
  return authHeader.replace(/^Bearer\s+/i, "").trim();
}

async function getLatestModelVersion(model: string, replicateToken: string): Promise<string> {
  const response = await fetch(`${REPLICATE_MODELS_URL}/${model}`, {
    headers: { Authorization: `Bearer ${replicateToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Failed to fetch model info:", error);
    throw new Error(`Failed to fetch model info for ${model}`);
  }

  const modelInfo = await response.json();
  const latestVersion = modelInfo.latest_version?.id;
  if (!latestVersion) {
    throw new Error(`No latest version found for model ${model}`);
  }

  console.log(`Model ${model} latest version: ${latestVersion}`);
  return latestVersion;
}

async function createReplicatePrediction(version: string, input: Record<string, unknown>, replicateToken: string) {
  // Use the standard predictions endpoint with a version ID
  const response = await fetch(REPLICATE_PREDICTIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${replicateToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ version, input }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Replicate create prediction error:", errorText);
    // Include status + body so the client/logs show the real validation issue (e.g. missing required fields)
    throw new Error(`Replicate prediction start failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function getReplicatePrediction(predictionId: string, replicateToken: string) {
  const response = await fetch(`${REPLICATE_PREDICTIONS_URL}/${predictionId}`, {
    headers: { Authorization: `Bearer ${replicateToken}` },
  });
  if (!response.ok) {
    const error = await response.text();
    console.error("Replicate get prediction error:", error);
    throw new Error("Failed to fetch Replicate prediction status");
  }
  return response.json();
}

// ============================================
// STEP 1: Script Generation with Gemini 3 Preview
// ============================================
// Content compliance instruction (from generate-video)
const CONTENT_COMPLIANCE_INSTRUCTION = `
CONTENT POLICY (MANDATORY):
- Generate only family-friendly, appropriate content
- No explicit violence, gore, or disturbing imagery
- No sexual or adult content
- No hate speech, discrimination, or offensive stereotypes
- No content promoting illegal activities
- Keep all content suitable for general audiences
`;

// Get style prompt from STYLE_PROMPTS dictionary
function getStylePrompt(style: string, customStyle?: string): string {
  const key = style.toLowerCase();
  return STYLE_PROMPTS[key] || customStyle || style;
}

async function generateScriptWithGemini(
  content: string,
  params: Required<Pick<CinematicRequest, "format" | "length" | "style">> &
    Partial<
      Pick<
        CinematicRequest,
        | "customStyle"
        | "brandMark"
        | "presenterFocus"
        | "characterDescription"
        | "disableExpressions"
        | "characterConsistencyEnabled"
        | "voiceType"
        | "voiceId"
        | "voiceName"
      >
    >,
  openrouterApiKey: string,
): Promise<{ title: string; scenes: Scene[]; characters?: Record<string, string> }> {
  console.log("Step 1: Generating script with Gemini 3 Preview...");

  // Get dimensions based on format
  const dimensions =
    params.format === "portrait"
      ? { width: 1080, height: 1920 }
      : params.format === "square"
        ? { width: 1080, height: 1080 }
        : { width: 1920, height: 1080 };

  // Length configuration - dynamic scene count ranges
  const lengthConfig: Record<
    string,
    { minScenes: number; maxScenes: number; targetDuration: number; maxSceneDuration: number }
  > = {
    short: { minScenes: 11, maxScenes: 17, targetDuration: 165, maxSceneDuration: 10 },
    brief: { minScenes: 6, maxScenes: 10, targetDuration: 150, maxSceneDuration: 10 },
    presentation: { minScenes: 8, maxScenes: 12, targetDuration: 180, maxSceneDuration: 10 },
  };
  const config = lengthConfig[params.length] || lengthConfig.brief;

  const styleDescription = getStylePrompt(params.style, params.customStyle);

  // Build optional guidance sections
  const presenterGuidance = params.presenterFocus ? `\n**Presenter/Focus Guidance:** ${params.presenterFocus}` : "";

  const characterGuidance = params.characterDescription
    ? `\n**Character Appearance:** All human characters MUST match: ${params.characterDescription}`
    : "";

  // Detect Haitian Creole from input content OR presenter_focus language setting
  const inputIsCreole = isHaitianCreole(content);
  const presenterFocusLower = (params.presenterFocus || "").toLowerCase();
  const forceCreoleFromPresenter =
    presenterFocusLower.includes("haitian") ||
    presenterFocusLower.includes("kreyòl") ||
    presenterFocusLower.includes("kreyol") ||
    presenterFocusLower.includes("creole");
  const isCreoleProject = inputIsCreole || forceCreoleFromPresenter;
  console.log(
    `[Script] Haitian Creole detection: content=${inputIsCreole}, presenterFocus=${forceCreoleFromPresenter}, final=${isCreoleProject}`,
  );

  const languageInstruction = isCreoleProject
    ? `### LANGUAGE REQUIREMENT
IMPORTANT: The user's input is in Haitian Creole (Kreyòl Ayisyen). You MUST:
- Write ALL voiceover/narration text in Haitian Creole
- Keep ALL proper nouns, brand names, and slogans in their ORIGINAL language (do NOT translate them)
- Write visualPrompt descriptions in ENGLISH (these are for image AI, not shown to users)
- Write the "title" in Haitian Creole
- The voiceover must sound natural in Haitian Creole, not like a word-for-word translation`
    : `### LANGUAGE REQUIREMENT
ALWAYS generate in ENGLISH unless the user EXPLICITLY requests Haitian Creole (Kreyòl Ayisyen).
If input is in another language, TRANSLATE to English.`;

  const systemPrompt = `You are a world-class Cinematic Director and Screenwriter.

Your goal is to turn a user's request into a compelling, production-ready video script and visual plan.

${CONTENT_COMPLIANCE_INSTRUCTION}

### PHASE 1: ASSESS & STRATEGIZE

First, analyze the User's Request to determine the best approach:

1. **Core Message:** What is the single most important idea to convey?
2. **Audience:** Who is watching? (e.g., investors, social media, students).
3. **Narrative Arc:** Choose the best structure (Explainer, Cinematic Journey, or Montage).

=== CONTENT ANALYSIS (CRITICAL - DO THIS FIRST) ===
Before writing the script, carefully analyze the content to identify:
1. **KEY CHARACTERS:** Who are the people/entities mentioned?
2. **GENDER:** Determine gender from context (names, pronouns, roles, topics)
3. **ROLES & RELATIONSHIPS:** Who does what?
4. **VISUAL CONSISTENCY:** The SAME character must look IDENTICAL across ALL scenes
5. **TEMPORAL CONTEXT:** Childhood → show AS A CHILD, Adult → show AS ADULT
6. **HISTORICAL/CULTURAL CONTEXT:** Match clothing, hairstyles, technology to time period

### PHASE 2: ANIMATION RULES (CRITICAL & STRICT)

You are writing prompts for a generative video AI that CANNOT do lip-sync. You must follow these rules strictly:

1. **NO TALKING FACES:** Characters must **NEVER** be described as "talking", "speaking", "saying", or "moving mouth".

2. **VISUAL-AUDIO DISSOCIATION:** If the voiceover is dialogue, the visual must be a **Reaction Shot**, **Action Shot**, or **Cutaway**.
   - *Bad:* "Close up of John explaining the plan."
   - *Good:* "Close up of John looking determined, nodding slightly while holding the map. Subtle wind blows his hair."

3. **ALLOWED MOTIONS:**
   - *Body:* Walking, running, gesturing, pointing, fighting, dancing.
   - *Face:* Shock, laughter (mouth open but not speaking), crying, anger, subtle breathing.
   - *Camera:* Dolly zoom, tracking shot, pan, tilt, rack focus.

4. **STATIC POSES:** For dialogue-heavy moments, use "Static pose with subtle breathing and idle movement" or "Cinematic portrait, staring intensely."

### PHASE 3: SCENE CREATION

⚠️ MANDATORY SCENE COUNT RULE — THIS IS NON-NEGOTIABLE:
You MUST generate a MINIMUM of ${config.minScenes} scenes and a MAXIMUM of ${config.maxScenes} scenes.
- Generating fewer than ${config.minScenes} scenes is a CRITICAL FAILURE. Do NOT do it.
- Generating more than ${config.maxScenes} scenes is also a failure.
- Count your scenes before finalizing. If you have fewer than ${config.minScenes}, ADD MORE scenes.
- The acceptable range is EXACTLY ${config.minScenes} to ${config.maxScenes} scenes. No exceptions.

**TARGET DURATION:** ~${config.targetDuration} seconds total (under 3 minutes)
**MAX PER SCENE:** ${config.maxSceneDuration} seconds each

### INPUT CONTEXT

- **Visual Style:** ${styleDescription}
- **Aspect Ratio:** ${params.format} (${dimensions.width}x${dimensions.height})
- **Tone:** cinematic${presenterGuidance}${characterGuidance}

**User's Content:**
${content}

${languageInstruction}

### VIDEO-FIRST VISUAL PROMPTS (CRITICAL)
Your visualPrompt must be optimized for AI VIDEO generation, NOT static images. Focus on:

1. **MOTION & DYNAMICS:** Describe movement, action, flow
   - ✓ "Camera slowly pushes in as the protagonist walks forward through fog"
   - ✗ "A person standing in fog"

2. **CAMERA MOVEMENT:** Specify how the camera behaves
   - Tracking shot, Dolly in/out, Crane up, Handheld, Steady glide, Orbit around subject
   - "Low angle drone shot tracking fast across urban rooftops at golden hour"

3. **CINEMATIC LIGHTING:** Be specific about light quality
   - "Cyberpunk neon reflections on wet pavement", "Soft rim light separating subject from background"
   - "Dramatic Rembrandt lighting with deep shadows"

4. **COMPOSITION:** Describe framing and depth
   - "Subject in left third of frame, shallow depth of field blurring city lights behind"
   - "Extreme close-up on eyes, rack focus to hands in foreground"

5. **ATMOSPHERE & MOOD:** Set the emotional tone visually
   - "Tense, claustrophobic framing", "Expansive, hopeful wide shot"

=== ENVIRONMENT & SETTING (MANDATORY) ===
**EVERY scene MUST include a detailed environment/setting that matches the story context.**
Do NOT create empty or minimal backgrounds. The environment tells the story!

For each visualPrompt, specify:
- **WHERE:** Location (kitchen, office, street, forest, etc.)
- **WHAT'S AROUND:** Props, furniture, objects that add context
- **ATMOSPHERE:** Time of day, weather, lighting conditions
- **STORY RELEVANCE:** Environment should reinforce the narrative

BAD EXAMPLES (TOO MINIMAL):
- ✗ "A stick figure next to a cake" (no setting!)
- ✗ "Person standing on white background" (empty!)
- ✗ "Character with angry expression" (no context!)

GOOD EXAMPLES (RICH CONTEXT):
- ✓ "Inside a cluttered home kitchen at 2AM, dirty dishes piled in the sink, dim overhead light casting harsh shadows. A stick figure stands at the counter, surrounded by open flour bags and mixing bowls, staring angrily at a lopsided two-layer cake on a vintage pedestal."
- ✓ "A cramped office cubicle with sticky notes everywhere, coffee cups stacked, computer screen glowing. Through the window, city lights twinkle. The character slumps in an ergonomic chair, papers scattered across the desk."

=== CHARACTER BIBLE (REQUIRED) ===
You MUST create a "characters" object defining EVERY person/entity in the video for VISUAL CONSISTENCY across all scenes.

For each character specify:
- **GENDER** (male/female/other)
- **AGE** (specific age or age range)
- **Ethnicity/skin tone** (be specific)
- **Hair** (color, style, length)
- **Body type** (build, height)
- **Clothing** (period/age-appropriate, consistent across scenes)
- **Distinguishing features** that remain CONSTANT

When writing visualPrompt, COPY the full character description from your bible—don't just reference the name.
Example: Instead of "John enters the room", write "A 45-year-old Caucasian man with salt-and-pepper hair, square jaw, wearing a charcoal business suit (from character bible) enters the room..."

### SCENE 1 TITLE REQUIREMENT (MANDATORY)
The FIRST scene (Scene 1) MUST include a bold, prominent title overlay in the visualPrompt.
- Create a 3-6 word catchy title that captures the video's essence
- The title should be rendered as social-media-style headline text
- Example: "visualPrompt: 'UNLOCK YOUR POTENTIAL' in bold, modern sans-serif typography centered on screen..."

### VOICEOVER STYLE
- ENERGETIC, conversational, cinematic tone
- Start each scene with a hook that grabs attention
- NO labels, NO stage directions, NO markdown—just raw spoken text
${params.disableExpressions ? "- Do NOT include paralinguistic tags like [chuckle], [sigh], etc." : "- Include natural expressions where appropriate: [sigh], [chuckle], [gasp], [laugh]"}

### TTS CONTENT FILTER SAFETY (CRITICAL)
The voiceover text will be synthesized by Google Gemini TTS, which has aggressive content filters.
You MUST avoid ANY words or phrases that could trigger safety filters, including:
- **Onomatopoeia for violence/explosions:** NEVER use "BOUM", "BOOM", "BANG", "POW", "CRASH", "BLAST", "SMASH", "KABOOM", "SLASH", "STAB", "SHOOT", "KILL", "MURDER", "SLAUGHTER"
- **Weapons & combat:** Avoid "gun", "rifle", "bomb", "grenade", "bullet", "sword", "knife" in narration
- **Graphic body language:** Avoid "blood", "bleeding", "guts", "gore", "wound"
- **Profanity or slurs:** Absolutely none, even mild ones
- **Drug references:** Avoid explicit drug names or usage descriptions
- **Sexual content:** No suggestive or explicit language whatsoever
- **Self-harm references:** No mentions of suicide, self-harm, or related topics

INSTEAD, use safe alternatives:
- "BOUM/BOOM" → "Suddenly..." or "In a flash..." or "Like lightning..."
- "BANG" → "A loud sound..." or "Toudenkou..." (in Creole)
- "CRASH" → "A sudden impact..." or "Everything collided..."
- For dramatic moments, use emotional language instead of sound effects
- Express intensity through pacing, pauses, and vocal energy—NOT violent words

This applies to ALL languages including Haitian Creole. Even translated versions of these words will be flagged.

### HISTORICAL, CULTURAL & VISUAL ACCURACY (CRITICAL)
You are generating visual prompts that will be used to create illustrations. You MUST ensure absolute accuracy:
- **Historical accuracy**: If the content is about a specific time period (e.g. England 1400s), ALL visual elements must match that era — architecture, clothing, weapons, tools, furniture, hairstyles, and technology. Do NOT mix elements from different centuries or regions (e.g. no French châteaux in an English medieval scene, no Victorian clothing in a Renaissance scene).
- **Geographic accuracy**: Landscapes, vegetation, weather, and urban design must match the real-world location being depicted. A scene set in West Africa should NOT look like Northern Europe.
- **Ethnic & facial accuracy**: Characters must reflect the correct ethnicity, skin tone, facial features, hair texture, and body type for the culture and region being depicted. If the topic is about the Zulu Kingdom, characters must look Southern African — not European or East Asian.
- **Cultural accuracy**: Clothing, jewelry, rituals, food, musical instruments, religious symbols, and social customs must be culturally authentic and specific to the people and era described.
- **Name & spelling accuracy**: Proper nouns, place names, historical figure names, and brand names must be spelled correctly in both voiceover text and visual prompts.
- **Color & material accuracy**: When the chosen style allows realistic colors, use historically/culturally accurate colors for flags, uniforms, traditional garments, heraldry, and national symbols.
- **Context coherence**: Every object, person, and setting in the visual prompt must belong to the same time, place, and cultural context. No anachronisms (e.g. no smartphones in ancient Rome, no electric lights in 1200s Japan).
- When unsure about specifics, err on the side of the MOST COMMONLY DOCUMENTED historical/cultural representation.

### OUTPUT FORMAT
Return ONLY valid JSON (no markdown, no \`\`\`json blocks):
{
  "title": "A Creative, Compelling Title",
  "characters": {
    "Protagonist": "A 32-year-old woman with shoulder-length black hair, warm brown skin, athletic build, wearing a tailored navy blazer and white blouse. Distinguishing features: bright smile, small gold hoop earrings.",
    "Mentor": "A 55-year-old East Asian man with graying temples, kind eyes, slim build, wearing a gray cardigan over a button-down shirt. Distinguishing features: reading glasses, gentle demeanor."
  },
  "scenes": [
    {
      "number": 1,
      "voiceover": "Engaging narration that hooks the viewer immediately...",
      "visualPrompt": "'THE JOURNEY BEGINS' in bold, modern typography fading in over: Slow dolly push through morning mist. A 32-year-old woman with shoulder-length black hair, warm brown skin, athletic build, wearing a tailored navy blazer (from character bible) steps into frame from the right. Camera tracks her movement. She walks purposefully but does NOT speak—static determined expression with subtle breathing. Shallow depth of field, lens flare kissing the edge of frame.",
      "visualStyle": "Cinematic establishing shot with atmospheric depth",
      "duration": 8
    }
  ]
}`;
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3.1-pro-preview",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Create a cinematic video script based on this idea:\n\n${content}` },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "create_script",
            description: "Create a cinematic video script with title, characters, and scenes",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string", description: "The video title" },
                characters: {
                  type: "object",
                  description: "Character bible with visual descriptions for consistency",
                  additionalProperties: { type: "string" },
                },
                scenes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      number: { type: "number" },
                      voiceover: { type: "string", description: "The narration text" },
                      visualPrompt: { type: "string", description: "Detailed visual description for image generation" },
                      visualStyle: { type: "string", description: "Camera/shot style descriptor" },
                      duration: { type: "number", description: "Duration in seconds (5-20)" },
                    },
                    required: ["number", "voiceover", "visualPrompt", "visualStyle", "duration"],
                  },
                },
              },
              required: ["title", "scenes"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "create_script" } },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("Gemini 3 error:", error);
    throw new Error("Failed to generate script with Gemini 3 Preview");
  }

  const data = await response.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    const parsed = JSON.parse(toolCall.function.arguments);
    if (!parsed.title || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
      throw new Error("Invalid script structure from Gemini");
    }

    const styleDescription = getStylePrompt(params.style, params.customStyle);

    return {
      title: parsed.title,
      characters: parsed.characters || {},
      scenes: parsed.scenes.map((s: any, idx: number) => ({
        number: s?.number ?? idx + 1,
        voiceover: s?.voiceover ?? "",
        visualPrompt: `${s?.visualPrompt ?? ""}\n\nSTYLE: ${styleDescription}`,
        visualStyle: s?.visualStyle ?? "cinematic",
        duration: typeof s?.duration === "number" ? s.duration : 8,
      })),
    };
  }

  throw new Error("No tool call response from Gemini 3");
}

// ============================================
// STEP 2: Audio Generation — delegates to Universal Audio Engine
// (_shared/audioEngine.ts) for all TTS routing, key rotation, and batching.
// ============================================

// resolveChatterbox removed — shared engine handles Chatterbox synchronously

// ============================================
// STEP 3: Image Generation with Hypereal gemini-3-1-flash-t2i
// ============================================
const HYPEREAL_API_URL = "https://hypereal.tech/api/v1/images/generate";

async function generateSceneImage(
  scene: Scene,
  style: string,
  format: "landscape" | "portrait" | "square",
  replicateToken: string,
  supabase: ReturnType<typeof createClient>,
): Promise<string> {
  const aspectRatio = format === "portrait" ? "9:16" : format === "square" ? "1:1" : "16:9";

  const styleKey = style.toLowerCase();
  const fullStylePrompt = STYLE_PROMPTS[styleKey] || STYLE_PROMPTS[style] || style;

  const imagePrompt = `${fullStylePrompt}

SCENE DESCRIPTION: ${scene.visualPrompt}

CAMERA/SHOT STYLE: ${scene.visualStyle}

FORMAT: ${format === "portrait" ? "VERTICAL 9:16 portrait orientation (tall, like a phone screen)" : format === "square" ? "SQUARE 1:1 aspect ratio (equal width and height)" : "HORIZONTAL 16:9 landscape orientation (wide, like a TV screen)"}. The image MUST be composed for this exact aspect ratio.

QUALITY REQUIREMENTS:
- ULTRA DETAILED with rich textures, accurate lighting, and proper shadows
- ANATOMICAL ACCURACY for any humans, animals, or creatures depicted
- Cinematic quality with dramatic lighting
- Ultra high resolution
- Professional illustration with dynamic composition and clear visual hierarchy`;

  const hyperealApiKey = Deno.env.get("HYPEREAL_API_KEY");
  const MAX_IMG_RETRIES = 4;

  // Prefer Hypereal gemini-3-1-flash-t2i
  if (hyperealApiKey) {
    console.log(
      `[IMG] Generating scene ${scene.number} with Hypereal gemini-3-1-flash-t2i, format: ${format}, aspect_ratio: ${aspectRatio}`,
    );

    for (let attempt = 1; attempt <= MAX_IMG_RETRIES; attempt++) {
      try {
        const response = await fetch(HYPEREAL_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${hyperealApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: imagePrompt,
            model: "gemini-3-1-flash-t2i",
            resolution: "4k",
            aspect_ratio: aspectRatio,
            output_format: "png",
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error(`[IMG] Hypereal create failed (attempt ${attempt}): ${response.status} - ${errText}`);

          // FIX 2: Only retry on 429, not 5xx (avoids double-billing on timeout)
          if (response.status === 429 && attempt < MAX_IMG_RETRIES) {
            const retryAfterMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
            console.warn(
              `[IMG] Scene ${scene.number}: Rate limited (${response.status}), retry ${attempt}/${MAX_IMG_RETRIES} in ${retryAfterMs}ms`,
            );
            await sleep(retryAfterMs);
            continue;
          }

          throw new Error(`Hypereal gemini-3-1-flash-t2i failed: ${response.status}`);
        }

        const data = await response.json();
        console.log(`[IMG] Hypereal raw response keys:`, Object.keys(data), `data array length:`, data.data?.length);

        // Handle response - Hypereal returns { data: [{ url: "..." }] }
        const imageUrl =
          data.data?.[0]?.url ||
          data.output?.url ||
          data.url ||
          data.image_url ||
          (Array.isArray(data.output) ? data.output[0] : null);
        const imageBase64 = data.output?.base64 || data.base64 || data.image;

        let imageBuffer: Uint8Array;

        if (imageBase64) {
          const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
          imageBuffer = Uint8Array.from(atob(cleanBase64), (c) => c.charCodeAt(0));
          console.log(`[IMG] Hypereal success (base64): ${imageBuffer.length} bytes`);
        } else if (imageUrl) {
          console.log(`[IMG] Hypereal success, downloading from: ${imageUrl.substring(0, 80)}...`);
          const imgResponse = await fetch(imageUrl);
          if (!imgResponse.ok) throw new Error("Failed to download Hypereal image");
          imageBuffer = new Uint8Array(await imgResponse.arrayBuffer());
          console.log(`[IMG] Scene ${scene.number} image downloaded: ${imageBuffer.length} bytes`);
        } else {
          console.error(`[IMG] No image data in Hypereal response:`, JSON.stringify(data).substring(0, 300));
          throw new Error("No image data returned from Hypereal");
        }

        const fileName = `cinematic-scene-${Date.now()}-${scene.number}.png`;
        const upload = await supabase.storage
          .from("scene-images")
          .upload(fileName, imageBuffer, { contentType: "image/png", upsert: true });

        if (upload.error) {
          try {
            await supabase.storage.createBucket("scene-images", { public: true });
            const retry = await supabase.storage
              .from("scene-images")
              .upload(fileName, imageBuffer, { contentType: "image/png", upsert: true });
            if (retry.error) throw retry.error;
          } catch (e) {
            console.error("Image upload error:", upload.error);
            throw new Error("Failed to upload scene image");
          }
        }

        const { data: urlData } = supabase.storage.from("scene-images").getPublicUrl(fileName);
        console.log(`[IMG] Scene ${scene.number} image uploaded: ${urlData.publicUrl}`);
        return urlData.publicUrl;
      } catch (err) {
        if (attempt >= MAX_IMG_RETRIES) {
          console.error(`[IMG] Scene ${scene.number} Hypereal error after ${MAX_IMG_RETRIES} attempts:`, err);
          throw err;
        }
        const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
        console.warn(`[IMG] Scene ${scene.number}: Error on attempt ${attempt}, retrying in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }

  // Fallback to Replicate nano-banana-2 if Hypereal key not available
  console.log(`[IMG] HYPEREAL_API_KEY not set, falling back to Replicate nano-banana-2 for scene ${scene.number}`);

  for (let attempt = 1; attempt <= MAX_IMG_RETRIES; attempt++) {
    try {
      const createResponse = await fetch(`https://api.replicate.com/v1/models/${NANO_BANANA_MODEL}/predictions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${replicateToken}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({
          input: {
            prompt: imagePrompt,
            aspect_ratio: aspectRatio,
            output_format: "png",
          },
        }),
      });

      if (!createResponse.ok) {
        const errText = await createResponse.text();
        console.error(
          `[IMG] Replicate nano-banana-2 create failed (attempt ${attempt}): ${createResponse.status} - ${errText}`,
        );

        // FIX 2: Only retry on 429, not 5xx
        if (createResponse.status === 429 && attempt < MAX_IMG_RETRIES) {
          const retryAfterMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
          await sleep(retryAfterMs);
          continue;
        }
        throw new Error(`Replicate nano-banana-2 failed: ${createResponse.status}`);
      }

      let prediction = await createResponse.json();

      while (prediction.status !== "succeeded" && prediction.status !== "failed") {
        await sleep(2000);
        const pollResponse = await fetch(`${REPLICATE_PREDICTIONS_URL}/${prediction.id}`, {
          headers: { Authorization: `Bearer ${replicateToken}` },
        });
        prediction = await pollResponse.json();
      }

      if (prediction.status === "failed") {
        throw new Error(prediction.error || "Image generation failed");
      }

      const first = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
      const imageUrl = typeof first === "string" ? first : first?.url || null;
      if (!imageUrl) throw new Error("No image URL returned from Replicate");

      const imgResponse = await fetch(imageUrl);
      if (!imgResponse.ok) throw new Error("Failed to download image");

      const imageBuffer = new Uint8Array(await imgResponse.arrayBuffer());
      const fileName = `cinematic-scene-${Date.now()}-${scene.number}.png`;
      const upload = await supabase.storage
        .from("scene-images")
        .upload(fileName, imageBuffer, { contentType: "image/png", upsert: true });

      if (upload.error) {
        try {
          await supabase.storage.createBucket("scene-images", { public: true });
          const retry = await supabase.storage
            .from("scene-images")
            .upload(fileName, imageBuffer, { contentType: "image/png", upsert: true });
          if (retry.error) throw retry.error;
        } catch (e) {
          throw new Error("Failed to upload scene image");
        }
      }

      const { data: urlData } = supabase.storage.from("scene-images").getPublicUrl(fileName);
      return urlData.publicUrl;
    } catch (err) {
      if (attempt >= MAX_IMG_RETRIES) throw err;
      await sleep(2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000));
    }
  }

  throw new Error(`Image generation failed for scene ${scene.number} after ${MAX_IMG_RETRIES} retries`);
}

// ============================================
// STEP 4: Video Generation with Hypereal Seedance 1.5 Pro I2V
// ============================================
const HYPEREAL_VIDEO_URL = "https://hypereal.tech/api/v1/videos/generate";

async function startSeedance(
  scene: Scene,
  imageUrl: string,
  format: "landscape" | "portrait" | "square",
  _replicateToken: string,
) {
  const hyperealApiKey = Deno.env.get("HYPEREAL_API_KEY");
  if (!hyperealApiKey) throw new Error("HYPEREAL_API_KEY not configured");
  if (!imageUrl) throw new Error(`Hypereal Seedance 1.5: No imageUrl for scene ${scene.number}`);

  const aspectRatio = format === "portrait" ? "9:16" : format === "square" ? "1:1" : "16:9";

  const visualPrompt =
    scene.visualPrompt || scene.visual_prompt || scene.voiceover || "Cinematic scene with dramatic lighting";
  console.log(
    `[Seedance-Hypereal] Starting scene ${scene.number} | image: ${imageUrl.substring(0, 80)}... | prompt: ${visualPrompt.substring(0, 100)}...`,
  );

  const videoPrompt = `${visualPrompt}

ANIMATION RULES (CRITICAL):
- NO lip-sync talking animation - characters should NOT move their mouths as if speaking
- Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry
- Body movement IS allowed: walking, running, gesturing, pointing, reacting
- Environment animation IS allowed: wind, particles, camera movement, lighting changes
- Static poses with subtle breathing/idle movement are preferred for dialogue scenes
- Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement`;

  const MAX_RETRIES = 4;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(HYPEREAL_VIDEO_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hyperealApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "seedance-1-5-i2v",
          input: {
            prompt: videoPrompt,
            image: imageUrl,
            duration: 5,
            resolution: "720p",
            aspect_ratio: aspectRatio,
          },
          generate_audio: false,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[Seedance-Hypereal] Start failed (attempt ${attempt}): ${response.status} - ${errText}`);
        // FIX 2: Only retry on 429 (rate limit), NOT on 5xx (avoids double-billing)
        if (response.status === 429 && attempt < MAX_RETRIES) {
          const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
          console.warn(`[Seedance-Hypereal] Rate limited on attempt ${attempt}, retrying in ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }
        throw new Error(`Hypereal Seedance 1.5 I2V failed: ${response.status} - ${errText}`);
      }

      const data = await response.json();
      const jobId = data.jobId || data.id || data.task_id || data.prediction_id;
      if (!jobId) {
        console.error(`[Seedance-Hypereal] No jobId in response:`, JSON.stringify(data).substring(0, 300));
        throw new Error("Hypereal Seedance 1.5 returned no jobId");
      }
      console.log(`[Seedance-Hypereal] Job started: ${jobId}, credits: ${data.creditsUsed}`);
      return jobId as string;
    } catch (err: any) {
      const errMsg = err?.message || "";
      // FIX 2: Only retry on 429, not 5xx
      if (errMsg.includes("429") && attempt < MAX_RETRIES) {
        const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
        console.warn(`[Seedance-Hypereal] Rate limited on attempt ${attempt}, retrying in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Hypereal Seedance 1.5 I2V prediction failed after retries");
}

// ============================================
// Hypereal Video Job Polling
// ============================================
const HYPEREAL_JOB_POLL_URL = "https://hypereal.tech/api/v1/jobs";

async function resolveHyperealVideo(
  jobId: string,
  supabase: ReturnType<typeof createClient>,
  sceneNumber: number,
  model: string = "seedance-1-5-i2v",
): Promise<string | null | "RATE_LIMITED"> {
  const hyperealApiKey = Deno.env.get("HYPEREAL_API_KEY");
  if (!hyperealApiKey) throw new Error("HYPEREAL_API_KEY not configured");

  // Server-side throttle: 1s delay before each poll to reduce API pressure
  await new Promise(r => setTimeout(r, 1000));

  const response = await fetch(`${HYPEREAL_JOB_POLL_URL}/${jobId}?model=${model}&type=video`, {
    headers: { Authorization: `Bearer ${hyperealApiKey}` },
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Seedance-Hypereal] Poll failed for job ${jobId}: ${response.status} - ${errText}`);
    if (response.status === 429) return "RATE_LIMITED";
    if (response.status >= 500) return null; // Treat as still processing
    throw new Error(`Hypereal poll failed: ${response.status}`);
  }

  const data = await response.json();
  console.log(`[Seedance-Hypereal] Poll job ${jobId}: status=${data.status}`);

  if (data.status === "completed") {
    const videoUrl = data.outputUrl || data.output_url || data.url;
    if (!videoUrl) {
      console.error(`[Seedance-Hypereal] Completed but no outputUrl:`, JSON.stringify(data).substring(0, 300));
      throw new Error("Hypereal completed but returned no video URL");
    }

    // Download and upload to our storage
    console.log(`[Seedance-Hypereal] Downloading video for scene ${sceneNumber}: ${videoUrl}`);
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) throw new Error(`Failed to download Hypereal video: ${videoResponse.status}`);
    const videoBuffer = await videoResponse.arrayBuffer();

    const fileName = `cinematic-video-${Date.now()}-${sceneNumber}.mp4`;
    const upload = await supabase.storage
      .from("scene-videos")
      .upload(fileName, new Uint8Array(videoBuffer), { contentType: "video/mp4", upsert: true });

    if (upload.error) {
      try {
        await supabase.storage.createBucket("scene-videos", { public: true });
        await supabase.storage
          .from("scene-videos")
          .upload(fileName, new Uint8Array(videoBuffer), { contentType: "video/mp4", upsert: true });
      } catch (e) {
        throw new Error("Failed to upload Hypereal video to storage");
      }
    }

    const { data: urlData } = supabase.storage.from("scene-videos").getPublicUrl(fileName);
    console.log(`[Seedance-Hypereal] Video uploaded: ${urlData.publicUrl}`);
    return urlData.publicUrl;
  }

  if (data.status === "failed") {
    const errorMsg = data.error || "Hypereal video generation failed";
    console.error(`[Seedance-Hypereal] Job ${jobId} failed: ${errorMsg}`);
    if (errorMsg.includes("flagged as sensitive") || errorMsg.includes("E005")) {
      throw new Error("Content flagged as sensitive. Please try different visual descriptions.");
    }
    return SEEDANCE_TIMEOUT_RETRY;
  }

  // Still processing
  return null;
}

// Hypereal Seedance 1.5 Pro T2V — used for INITIAL generation (text-to-video, no image)
async function startSeedanceT2V(scene: Scene, format: "landscape" | "portrait" | "square") {
  const hyperealApiKey = Deno.env.get("HYPEREAL_API_KEY");
  if (!hyperealApiKey) throw new Error("HYPEREAL_API_KEY not configured");

  const aspectRatio = format === "portrait" ? "9:16" : format === "square" ? "1:1" : "16:9";

  const visualPrompt =
    scene.visualPrompt || scene.visual_prompt || scene.voiceover || "Cinematic scene with dramatic lighting";

  const videoPrompt = `${visualPrompt}

ANIMATION RULES (CRITICAL):
- NO lip-sync talking animation - characters should NOT move their mouths as if speaking
- Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry
- Body movement IS allowed: walking, running, gesturing, pointing, reacting
- Environment animation IS allowed: wind, particles, camera movement, lighting changes
- Static poses with subtle breathing/idle movement are preferred for dialogue scenes
- Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement`;

  console.log(
    `[Seedance-T2V] Starting scene ${scene.number} | model: seedance-1-5-t2v | prompt: ${videoPrompt.substring(0, 100)}...`,
  );

  const MAX_RETRIES = 4;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(HYPEREAL_VIDEO_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hyperealApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "seedance-1-5-t2v",
          input: {
            prompt: videoPrompt,
            duration: 5,
            resolution: "720p",
            aspect_ratio: aspectRatio,
          },
          generate_audio: false,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[Seedance-T2V] Start failed (attempt ${attempt}): ${response.status} - ${errText}`);
        // FIX 2: Only retry on 429, not 5xx
        if (response.status === 429 && attempt < MAX_RETRIES) {
          const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
          console.warn(`[Seedance-T2V] Rate limited on attempt ${attempt}, retrying in ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }
        throw new Error(`Hypereal Seedance 1.5 T2V failed: ${response.status} - ${errText}`);
      }

      const data = await response.json();
      const jobId = data.jobId || data.id || data.task_id || data.prediction_id;
      if (!jobId) {
        console.error(`[Seedance-T2V] No jobId in response:`, JSON.stringify(data).substring(0, 300));
        throw new Error("Hypereal Seedance 1.5 T2V returned no jobId");
      }
      console.log(`[Seedance-T2V] Job started: ${jobId}, credits: ${data.creditsUsed}`);
      return jobId as string;
    } catch (err: any) {
      const errMsg = err?.message || "";
      // FIX 2: Only retry on 429, not 5xx
      if (errMsg.includes("429") && attempt < MAX_RETRIES) {
        const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
        console.warn(`[Seedance-T2V] Rate limited on attempt ${attempt}, retrying in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Hypereal Seedance 1.5 T2V prediction failed after retries");
}

// Replicate bytedance/seedance-1-pro-fast — I2V fallback for initial generation
async function startSeedanceReplicateI2V(
  scene: Scene,
  imageUrl: string,
  format: "landscape" | "portrait" | "square",
  replicateToken: string,
) {
  const aspectRatio = format === "portrait" ? "9:16" : format === "square" ? "1:1" : "16:9";

  const visualPrompt =
    scene.visualPrompt || scene.visual_prompt || scene.voiceover || "Cinematic scene with dramatic lighting";

  const videoPrompt = `${visualPrompt}

ANIMATION RULES (CRITICAL):
- NO lip-sync talking animation - characters should NOT move their mouths as if speaking
- Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry
- Body movement IS allowed: walking, running, gesturing, pointing, reacting
- Environment animation IS allowed: wind, particles, camera movement, lighting changes
- Static poses with subtle breathing/idle movement are preferred for dialogue scenes
- Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement`;

  console.log(
    `[Seedance-Replicate-I2V] Starting scene ${scene.number} | model: ${SEEDANCE_VIDEO_MODEL} | image: ${imageUrl.substring(0, 80)}...`,
  );

  const MAX_RETRIES = 4;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`https://api.replicate.com/v1/models/${SEEDANCE_VIDEO_MODEL}/predictions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${replicateToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: {
            prompt: videoPrompt,
            image: imageUrl,
            duration: 5,
            aspect_ratio: aspectRatio,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[Seedance-Replicate-I2V] Start failed (attempt ${attempt}): ${response.status} - ${errText}`);
        // FIX 2: Only retry on 429, not 5xx
        if (response.status === 429 && attempt < MAX_RETRIES) {
          const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
          await sleep(delayMs);
          continue;
        }
        throw new Error(`Replicate seedance-1-pro-fast I2V failed: ${response.status} - ${errText}`);
      }

      const prediction = await response.json();
      const predictionId = prediction.id;
      if (!predictionId) {
        throw new Error("Replicate seedance-1-pro-fast I2V returned no prediction ID");
      }
      console.log(`[Seedance-Replicate-I2V] Prediction started: ${predictionId}`);
      return predictionId as string;
    } catch (err: any) {
      const errMsg = err?.message || "";
      // FIX 2: Only retry on 429, not 5xx
      if (errMsg.includes("429") && attempt < MAX_RETRIES) {
        const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Replicate seedance-1-pro-fast I2V prediction failed after retries");
}

async function startGrokVideo(
  scene: Scene,
  imageUrl: string,
  format: "landscape" | "portrait" | "square",
  replicateToken: string,
) {
  const aspectRatio = format === "portrait" ? "9:16" : format === "square" ? "1:1" : "16:9";

  const videoPrompt = `${scene.visualPrompt}

ANIMATION RULES (CRITICAL):
- NO lip-sync talking animation - characters should NOT move their mouths as if speaking
- Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry
- Body movement IS allowed: walking, running, gesturing, pointing, reacting
- Environment animation IS allowed: wind, particles, camera movement, lighting changes
- Static poses with subtle breathing/idle movement are preferred for dialogue scenes
- Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement`;

  const MAX_RETRIES = 4;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`https://api.replicate.com/v1/models/${GROK_VIDEO_MODEL}/predictions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${replicateToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: {
            prompt: videoPrompt,
            image: imageUrl,
            duration: 10,
            resolution: "720p",
            aspect_ratio: aspectRatio,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[GrokVideo] Create prediction error (attempt ${attempt}): ${response.status} - ${errorText}`);
        // FIX 2: Only retry on 429, not 5xx
        if (response.status === 429 && attempt < MAX_RETRIES) {
          const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
          console.warn(`[GrokVideo] Rate limited on attempt ${attempt}, retrying in ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }
        throw new Error(`Grok video prediction start failed (${response.status}): ${errorText}`);
      }

      const prediction = await response.json();
      console.log(`[GrokVideo] Prediction started: ${prediction.id}`);
      return prediction.id as string;
    } catch (err: any) {
      const errMsg = err?.message || "";
      // FIX 2: Only retry on 429, not 5xx
      if (errMsg.includes("429") && attempt < MAX_RETRIES) {
        const delayMs = 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
        console.warn(`[GrokVideo] Error on attempt ${attempt}, retrying in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Grok video prediction failed after retries");
}

const SEEDANCE_TIMEOUT_RETRY = "__TIMEOUT_RETRY__";

async function resolveSeedance(
  predictionId: string,
  replicateToken: string,
  supabase: ReturnType<typeof createClient>,
  sceneNumber: number,
): Promise<string | null> {
  const result = await getReplicatePrediction(predictionId, replicateToken);

  if (result.status !== "succeeded") {
    if (result.status === "failed" || result.status === "canceled") {
      const errorMsg = result.error || "Video generation failed";
      console.error("[Video] failed:", errorMsg, `(prediction ${predictionId})`);

      if (errorMsg.includes("flagged as sensitive") || errorMsg.includes("E005")) {
        throw new Error("Content flagged as sensitive. Please try different visual descriptions or a different topic.");
      }
      // ALL other failures (Queue full, timeout, generic Grok failures) → retryable
      console.warn(
        `[Video] Scene ${sceneNumber}: Failed (prediction ${predictionId}), marking as retryable. Error: ${errorMsg}`,
      );
      return SEEDANCE_TIMEOUT_RETRY;
    }
    return null;
  }

  const output = result.output;
  let videoUrl: string | null = null;

  if (typeof output === "string" && output) {
    videoUrl = output;
  } else if (Array.isArray(output) && output.length > 0) {
    videoUrl = typeof output[0] === "string" ? output[0] : null;
  } else if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    videoUrl = (obj.url || obj.video || obj.output) as string | null;
  }

  if (!videoUrl) {
    console.error("[Seedance] Succeeded but no video URL found. Output:", JSON.stringify(output));
    throw new Error("Replicate succeeded but returned no video URL");
  }

  console.log(`[Seedance] Downloading video for scene ${sceneNumber}: ${videoUrl}`);
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) {
    throw new Error(`Failed to download generated video: ${videoResponse.status}`);
  }
  const videoBuffer = await videoResponse.arrayBuffer();

  const fileName = `cinematic-video-${Date.now()}-${sceneNumber}.mp4`;
  const upload = await supabase.storage
    .from("scene-videos")
    .upload(fileName, new Uint8Array(videoBuffer), { contentType: "video/mp4", upsert: true });

  if (upload.error) {
    try {
      await supabase.storage.createBucket("scene-videos", { public: true });
      const retry = await supabase.storage
        .from("scene-videos")
        .upload(fileName, new Uint8Array(videoBuffer), { contentType: "video/mp4", upsert: true });
      if (retry.error) throw retry.error;
    } catch (e) {
      console.error("Video upload error:", upload.error);
      throw new Error("Failed to upload video to storage");
    }
  }

  const { data: urlData } = supabase.storage.from("scene-videos").getPublicUrl(fileName);
  console.log(`[Seedance] Video uploaded: ${urlData.publicUrl}`);
  return urlData.publicUrl;
}

async function readGenerationOwned(supabase: ReturnType<typeof createClient>, generationId: string, userId: string) {
  const { data, error } = await supabase
    .from("generations")
    .select("id, user_id, project_id, status, progress, scenes")
    .eq("id", generationId)
    .maybeSingle();

  if (error || !data) throw new Error("Generation not found");
  if (data.user_id !== userId) throw new Error("Forbidden");
  return data;
}

async function updateScenes(
  supabase: ReturnType<typeof createClient>,
  generationId: string,
  scenes: Scene[],
  progress?: number,
) {
  await supabase
    .from("generations")
    .update({ scenes, ...(typeof progress === "number" ? { progress } : {}) })
    .eq("id", generationId);
}

/** Atomic single-scene update using jsonb_set — prevents race conditions */
async function updateSceneAtIndex(
  supabase: ReturnType<typeof createClient>,
  generationId: string,
  sceneIndex: number,
  sceneData: Scene,
  progress?: number,
) {
  await supabase.rpc("update_scene_at_index", {
    p_generation_id: generationId,
    p_scene_index: sceneIndex,
    p_scene_data: sceneData as unknown as Record<string, unknown>,
    p_progress: progress ?? null,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let parsedGenerationId: string | undefined;

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonResponse({ error: "Not authenticated" }, { status: 401 });

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openrouterApiKey = Deno.env.get("OPENROUTER_API_KEY");
    const replicateToken = Deno.env.get("REPLICATE_API_TOKEN");

    if (!supabaseUrl || !supabaseKey) throw new Error("Backend configuration missing");
    if (!openrouterApiKey) throw new Error("OPENROUTER_API_KEY not configured");
    if (!replicateToken) throw new Error("REPLICATE_API_TOKEN not configured");

    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseAnonKey) throw new Error("SUPABASE_ANON_KEY not configured");

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify user via getClaims (local JWT validation — no network round-trip, no service-role mismatch)
    const token = sanitizeBearer(authHeader);
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return jsonResponse({ error: "Invalid authentication" }, { status: 401 });
    }
    const userId = claimsData.claims.sub as string;
    const userEmail = claimsData.claims.email as string;
    if (!userId) return jsonResponse({ error: "Invalid authentication" }, { status: 401 });
    const user = { id: userId, email: userEmail };

    // Verify plan access: Professional, Enterprise, or Admin
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: user.id });

    // Check subscription plan if not admin
    if (!isAdmin) {
      const { data: subData } = await supabase
        .from("subscriptions")
        .select("plan_name, status")
        .eq("user_id", user.id)
        .in("status", ["active"])
        .single();

      const userPlan = subData?.plan_name || "free";
      if (userPlan !== "professional" && userPlan !== "enterprise") {
        return jsonResponse(
          { error: "Cinematic generation requires a Professional or Enterprise plan." },
          { status: 403 },
        );
      }
    }

    const body: CinematicRequest = await req.json().catch(() => ({}));
    parsedGenerationId = body.generationId; // Cache for error handler
    const phase: Phase = body.phase || "script";

    // =============== PHASE 1: SCRIPT ===============
    if (phase === "script") {
      const content = requireString(body.content, "content");
      const format = (body.format || "portrait") as "landscape" | "portrait" | "square";
      const length = requireString(body.length, "length");
      const style = requireString(body.style, "style");

      // ============= UPFRONT CREDIT DEDUCTION (Atomic via RPC) =============
      const CINEMATIC_CREDIT_COST = 12;

      const { data: deductionSuccess, error: rpcError } = await supabase.rpc(
        "deduct_credits_securely",
        {
          p_user_id: user.id,
          p_amount: CINEMATIC_CREDIT_COST,
          p_transaction_type: "usage",
          p_description: `Cinematic generation started (${length})`,
        },
      );

      if (rpcError || !deductionSuccess) {
        console.error(`[CINEMATIC] Atomic deduction failed for user ${user.id}:`, rpcError?.message);
        return jsonResponse({
          error: `Insufficient credits. Cinematic generation requires ${CINEMATIC_CREDIT_COST} credits.`,
          code: "INSUFFICIENT_CREDITS",
        }, { status: 402 });
      }
      console.log(`[CINEMATIC] Securely deducted ${CINEMATIC_CREDIT_COST} credits for user ${user.id}`);
      // ============= END UPFRONT CREDIT DEDUCTION =============

      console.log("=== CINEMATIC SCRIPT START ===");

      const script = await generateScriptWithGemini(
        content,
        {
          format,
          length,
          style,
          customStyle: body.customStyle,
          brandMark: body.brandMark,
          presenterFocus: body.presenterFocus,
          characterDescription: body.characterDescription,
          disableExpressions: body.disableExpressions,
          characterConsistencyEnabled: body.characterConsistencyEnabled,
          voiceType: body.voiceType,
          voiceId: body.voiceId,
          voiceName: body.voiceName,
        },
        openrouterApiKey,
      );

      // Create project
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .insert({
          user_id: user.id,
          title: script.title,
          content,
          format,
          length,
          style,
          project_type: "cinematic",
          status: "generating",
          presenter_focus: body.presenterFocus || null,
          character_description: body.characterDescription || null,
          brand_mark: body.brandMark || null,
          voice_type: body.voiceType || "standard",
          voice_id: body.voiceId || null,
          voice_name: body.voiceName || null,
          character_consistency_enabled: body.characterConsistencyEnabled || false,
        })
        .select("id")
        .single();

      if (projectError || !project) throw new Error("Failed to create project");

      // Create generation
      const { data: generation, error: genError } = await supabase
        .from("generations")
        .insert({
          user_id: user.id,
          project_id: project.id,
          status: "generating",
          progress: 10,
          scenes: script.scenes,
        })
        .select("id")
        .single();

      if (genError || !generation) throw new Error("Failed to create generation record");

      return jsonResponse({
        success: true,
        projectId: project.id,
        generationId: generation.id,
        title: script.title,
        scenes: script.scenes,
        sceneCount: script.scenes.length,
      });
    }

    // All remaining phases require generationId
    const generationId = requireString(body.generationId, "generationId");
    const generation = await readGenerationOwned(supabase, generationId, user.id);

    const scenesRaw = Array.isArray(generation.scenes) ? generation.scenes : [];
    const scenes: Scene[] = scenesRaw.map((s: any, idx: number) => ({
      number: s?.number ?? idx + 1,
      voiceover: s?.voiceover ?? "",
      visualPrompt: s?.visualPrompt ?? "",
      visualStyle: s?.visualStyle ?? "cinematic",
      duration: typeof s?.duration === "number" ? s.duration : 6,
      audioUrl: s?.audioUrl,
      imageUrl: s?.imageUrl,
      videoUrl: s?.videoUrl,
      audioPredictionId: s?.audioPredictionId,
      videoPredictionId: s?.videoPredictionId,
      videoRetryCount: s?.videoRetryCount ?? 0,
      videoRetryAfter: s?.videoRetryAfter,
      videoProvider: s?.videoProvider,
      videoModel: s?.videoModel,
    }));

    const sceneIndex = typeof body.sceneIndex === "number" ? body.sceneIndex : undefined;
    const requestBody = body as CinematicRequest;

    // =============== PHASE 2: AUDIO (Universal Audio Engine) ===============
    if (phase === "audio") {
      const idx = requireNumber(sceneIndex, "sceneIndex");
      const scene = scenes[idx];
      if (!scene) throw new Error("Scene not found");

      // If regeneration, clear existing audio
      const isAudioRegen = typeof body.sceneIndex === "number" && !!scene.audioUrl;
      if (isAudioRegen) {
        console.log(`[AUDIO] Scene ${scene.number}: Clearing existing audio for regeneration`);
        scene.audioUrl = undefined;
        scene.audioPredictionId = undefined;
        scenes[idx] = scene;
        await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);
      }

      if (scene.audioUrl) {
        return jsonResponse({ success: true, status: "complete", scene });
      }

      // Get voice settings and presenter_focus from project
      const { data: project } = await supabase
        .from("projects")
        .select("voice_name, voice_type, voice_id, presenter_focus")
        .eq("id", generation.project_id)
        .maybeSingle();

      const voiceGender = project?.voice_name === "male" ? "male" : "female";
      const customVoiceId = project?.voice_type === "custom" ? project?.voice_id : undefined;

      // Detect Haitian Creole from presenter_focus
      const presenterFocusLower = (project?.presenter_focus || "").toLowerCase();
      const forceHaitianCreole =
        presenterFocusLower.includes("haitian") ||
        presenterFocusLower.includes("kreyòl") ||
        presenterFocusLower.includes("kreyol") ||
        presenterFocusLower.includes("creole");
      console.log(
        `[AUDIO] Scene ${scene.number}: presenterFocus="${project?.presenter_focus || "none"}", forceHaitianCreole=${forceHaitianCreole}`,
      );

      // Build Google API keys array (reverse order for failover)
      const googleApiKeys: string[] = [];
      const gk1 = Deno.env.get("GOOGLE_TTS_API_KEY");
      const gk2 = Deno.env.get("GOOGLE_TTS_API_KEY_2");
      const gk3 = Deno.env.get("GOOGLE_TTS_API_KEY_3");
      if (gk3) googleApiKeys.push(gk3);
      if (gk2) googleApiKeys.push(gk2);
      if (gk1) googleApiKeys.push(gk1);

      // Configure the Universal Audio Engine for cinematic storage
      const audioConfig: AudioEngineConfig = {
        replicateApiKey: replicateToken,
        googleApiKeys,
        elevenLabsApiKey: Deno.env.get("ELEVENLABS_API_KEY"),
        lemonfoxApiKey: Deno.env.get("LEMONFOX_API_KEY"),
        supabase,
        storage: {
          bucket: "audio-files",
          pathPrefix: "",
          useSignedUrls: false,
          filePrefix: "cinematic-audio",
        },
        voiceGender,
        customVoiceId,
        forceHaitianCreole,
      };

      // Call the shared audio engine (synchronous — waits for result)
      const result = await sharedGenerateSceneAudio(
        { number: scene.number, voiceover: scene.voiceover, duration: scene.duration },
        audioConfig,
      );

      if (result.url) {
        scenes[idx] = { ...scene, audioUrl: result.url, audioPredictionId: undefined };
        await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);
        return jsonResponse({ success: true, status: "complete", scene: scenes[idx] });
      }

      // Audio generation failed
      console.error(`[AUDIO] Scene ${scene.number}: TTS failed: ${result.error}`);
      return jsonResponse(
        { success: false, error: result.error || "Audio generation failed. Please try again later." },
        { status: 500 },
      );
    }

    // =============== PHASE 3: IMAGES ===============
    if (phase === "images") {
      const idx = requireNumber(sceneIndex, "sceneIndex");
      const scene = scenes[idx];
      if (!scene) throw new Error("Scene not found");

      if (scene.imageUrl) return jsonResponse({ success: true, status: "complete", scene });

      // We need style + format from the project record
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, style, format")
        .eq("id", generation.project_id)
        .maybeSingle();

      if (projectError || !project) throw new Error("Project not found");

      const imageUrl = await generateSceneImage(
        scene,
        project.style || "realistic",
        (project.format || "portrait") as "landscape" | "portrait" | "square",
        replicateToken,
        supabase,
      );

      scenes[idx] = { ...scene, imageUrl };
      await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);

      return jsonResponse({ success: true, status: "complete", scene: scenes[idx] });
    }

    // =============== PHASE 4: VIDEO ===============
    if (phase === "video") {
      const idx = requireNumber(sceneIndex, "sceneIndex");
      const scene = scenes[idx];
      if (!scene) throw new Error("Scene not found");

      // Explicit regeneration flag from frontend
      const isRegeneration = !!body.regenerate;
      if (isRegeneration) {
        console.log(
          `[VIDEO] Scene ${scene.number}: Clearing existing video for regeneration (using Grok Imagine Video)`,
        );
        scene.videoUrl = undefined;
        scene.videoPredictionId = undefined;
        scene.videoRetryCount = 0; // Reset retry counter on explicit regen
        scene.videoRetryAfter = undefined;
        scenes[idx] = scene;
        await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);
      }

      if (scene.videoUrl) return jsonResponse({ success: true, status: "complete", scene });

      // Read format from project
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, format")
        .eq("id", generation.project_id)
        .maybeSingle();
      if (projectError || !project) throw new Error("Project not found");

      const format = (project.format || "portrait") as "landscape" | "portrait" | "square";

      if (!scene.videoPredictionId) {
        // Both initial gen and regen use Hypereal Seedance 1.5
        // Initial = T2V (text-to-video, no image, 5s), Regen = I2V (image-to-video)
        if (isRegeneration) {
          const predictionId = await startSeedance(scene, scene.imageUrl, format, replicateToken);
          scenes[idx] = {
            ...scene,
            videoPredictionId: predictionId,
            videoRetryAfter: undefined,
            videoProvider: "hypereal",
            videoModel: "seedance-1-5-i2v",
          };
          await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);
          return jsonResponse({ success: true, status: "processing", scene: scenes[idx] });
        }

        // Initial generation: Hypereal Seedance 1.5 I2V (animate the generated image)
        // Fallback: Replicate bytedance/seedance-1-pro-fast (also I2V with image)
        if (!scene.imageUrl) {
          throw new Error(`Scene ${scene.number} has no imageUrl — images phase must run first`);
        }
        try {
          const predictionId = await startSeedance(scene, scene.imageUrl, format, replicateToken);
          scenes[idx] = {
            ...scene,
            videoPredictionId: predictionId,
            videoRetryAfter: undefined,
            videoProvider: "hypereal",
            videoModel: "seedance-1-5-i2v",
          };
          await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);
          return jsonResponse({ success: true, status: "processing", scene: scenes[idx] });
        } catch (i2vErr) {
          console.warn(
            `[VIDEO] Scene ${scene.number}: Hypereal I2V failed, falling back to Replicate seedance-1-pro-fast: ${i2vErr}`,
          );
          const predictionId = await startSeedanceReplicateI2V(scene, scene.imageUrl, format, replicateToken);
          scenes[idx] = {
            ...scene,
            videoPredictionId: predictionId,
            videoRetryAfter: undefined,
            videoProvider: "replicate",
            videoModel: "seedance-1-pro-fast",
          };
          await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);
          return jsonResponse({ success: true, status: "processing", scene: scenes[idx] });
        }
      }

      // Route to the correct resolver based on provider
      const videoUrl =
        scene.videoProvider === "hypereal"
          ? await resolveHyperealVideo(
              scene.videoPredictionId,
              supabase,
              scene.number,
              scene.videoModel || "seedance-1-5-i2v",
            )
          : await resolveSeedance(scene.videoPredictionId, replicateToken, supabase, scene.number);

      if (videoUrl === SEEDANCE_TIMEOUT_RETRY) {
        // FIX 1: Do NOT auto-retrigger a new video job — this wastes credits.
        // Instead, return a hard error so the user can manually regenerate.
        console.error(
          `[VIDEO] Scene ${scene.number}: Provider reported job failed. Stopping — user must regenerate manually.`,
        );
        scenes[idx] = { ...scene, videoPredictionId: undefined, videoRetryCount: 0 };
        await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);
        return jsonResponse(
          { success: false, error: `Video generation failed for scene ${scene.number}. Please regenerate this scene manually.` },
          { status: 500 },
        );
      }

      if (videoUrl === "RATE_LIMITED") {
        console.log(`[VIDEO] Scene ${scene.number}: Hypereal rate limited, telling client to back off 30s`);
        return jsonResponse({ success: true, status: "processing", retryAfterMs: 30000, scene });
      }

      if (!videoUrl) {
        return jsonResponse({ success: true, status: "processing", retryAfterMs: 8000, scene });
      }

      scenes[idx] = { ...scene, videoUrl };
      await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);

      return jsonResponse({ success: true, status: "complete", scene: scenes[idx] });
    }

    // =============== IMAGE-EDIT PHASE (Apply modification then regenerate video) ===============
    if (phase === "image-edit") {
      const idx = requireNumber(sceneIndex, "sceneIndex");
      const scene = scenes[idx];
      if (!scene) throw new Error("Scene not found");

      const modification = requestBody.imageModification || "";
      if (!modification.trim()) throw new Error("Image modification is required for image-edit phase");

      // Get project for style/format
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, style, format")
        .eq("id", generation.project_id)
        .maybeSingle();
      if (projectError || !project) throw new Error("Project not found");

      const format = (project.format || "portrait") as "landscape" | "portrait" | "square";
      const style = project.style || "realistic";

      // Use Replicate nano-banana-pro for image editing (cinematic is Pro-only)
      const replicateApiToken = Deno.env.get("REPLICATE_API_TOKEN") || replicateToken;

      const fullStylePrompt = getStylePrompt(style);
      const editPrompt = `Edit this image with the following modification: ${modification}

IMPORTANT REQUIREMENTS:
- Preserve the overall composition, lighting, and style of the original image
- Apply ONLY the requested modification while keeping everything else intact
- Maintain the same artistic style and color palette

STYLE CONTEXT: ${fullStylePrompt}`;

      console.log(`[IMG-EDIT] Scene ${scene.number}: Applying edit via Replicate nano-banana-pro`);

      const editInput: Record<string, unknown> = {
        prompt: editPrompt,
        image_input: [scene.imageUrl],
        aspect_ratio: format === "portrait" ? "9:16" : format === "square" ? "1:1" : "16:9",
        output_format: "png",
        resolution: "1K",
      };

      const editResponse = await fetch("https://api.replicate.com/v1/models/google/nano-banana-pro/predictions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${replicateApiToken}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({ input: editInput }),
      });

      if (!editResponse.ok) {
        const errText = await editResponse.text();
        console.error(`[IMG-EDIT] Replicate nano-banana-pro failed: ${editResponse.status} - ${errText}`);
        throw new Error("Image editing failed");
      }

      let editPrediction = await editResponse.json();
      console.log(
        `[IMG-EDIT] Nano Banana Pro prediction started: ${editPrediction.id}, status: ${editPrediction.status}`,
      );

      // Poll for completion if not finished
      while (editPrediction.status !== "succeeded" && editPrediction.status !== "failed") {
        await sleep(2000);
        const pollResponse = await fetch(`${REPLICATE_PREDICTIONS_URL}/${editPrediction.id}`, {
          headers: { Authorization: `Bearer ${replicateApiToken}` },
        });
        editPrediction = await pollResponse.json();
      }

      if (editPrediction.status === "failed") {
        console.error(`[IMG-EDIT] Nano Banana Pro prediction failed: ${editPrediction.error}`);
        throw new Error(editPrediction.error || "Image edit failed");
      }

      // Get image URL from output
      const editFirst = Array.isArray(editPrediction.output) ? editPrediction.output[0] : editPrediction.output;
      const editedImageUrl = typeof editFirst === "string" ? editFirst : editFirst?.url || null;

      if (!editedImageUrl) {
        throw new Error("No edited image returned from Replicate");
      }

      // Download and upload to storage
      const editedImgResponse = await fetch(editedImageUrl);
      if (!editedImgResponse.ok) throw new Error("Failed to download edited image");
      const imageBuffer = new Uint8Array(await editedImgResponse.arrayBuffer());

      const fileName = `cinematic-scene-edited-${Date.now()}-${scene.number}.png`;
      const upload = await supabase.storage
        .from("scene-images")
        .upload(fileName, imageBuffer, { contentType: "image/png", upsert: true });

      if (upload.error) {
        try {
          await supabase.storage.createBucket("scene-images", { public: true });
          await supabase.storage
            .from("scene-images")
            .upload(fileName, imageBuffer, { contentType: "image/png", upsert: true });
        } catch (e) {
          throw new Error("Failed to upload edited image");
        }
      }

      const { data: urlData } = supabase.storage.from("scene-images").getPublicUrl(fileName);
      const newImageUrl = urlData.publicUrl;
      console.log(`[IMG-EDIT] Scene ${scene.number} edited image uploaded: ${newImageUrl}`);

      // Now regenerate video with the new image
      // Grok commented out for testing — use Hypereal Seedance 1.5
      console.log(`[IMG-EDIT] Scene ${scene.number}: Starting video regeneration with Hypereal Seedance 1.5`);
      const predictionId = await startSeedance(scene, newImageUrl, format, replicateToken);

      // Save prediction ID so the "video" phase can pick it up on subsequent polls
      scenes[idx] = {
        ...scene,
        imageUrl: newImageUrl,
        videoPredictionId: predictionId,
        videoUrl: undefined,
        videoRetryCount: 0,
        videoRetryAfter: undefined,
        videoProvider: "hypereal",
      };
      await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);

      // Return processing status immediately to avoid Edge Function timeout
      console.log(`[IMG-EDIT] Scene ${scene.number}: Returning processing status, frontend will poll video phase`);
      return jsonResponse({ success: true, status: "processing", scene: scenes[idx] });
    }

    // =============== IMAGE-REGEN PHASE (Full regenerate image then video) ===============
    if (phase === "image-regen") {
      const idx = requireNumber(sceneIndex, "sceneIndex");
      const scene = scenes[idx];
      if (!scene) throw new Error("Scene not found");

      // Get project for style/format
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, style, format")
        .eq("id", generation.project_id)
        .maybeSingle();
      if (projectError || !project) throw new Error("Project not found");

      const format = (project.format || "portrait") as "landscape" | "portrait" | "square";
      const style = project.style || "realistic";

      console.log(`[IMG-REGEN] Scene ${scene.number}: Regenerating image`);

      // Generate new image
      const newImageUrl = await generateSceneImage(scene, style, format, replicateToken, supabase);

      // Grok commented out for testing — use Hypereal Seedance 1.5
      console.log(`[IMG-REGEN] Scene ${scene.number}: Starting video regeneration with Hypereal Seedance 1.5`);
      const predictionId = await startSeedance(scene, newImageUrl, format, replicateToken);

      // Save prediction ID so the "video" phase can pick it up on subsequent polls
      scenes[idx] = {
        ...scene,
        imageUrl: newImageUrl,
        videoPredictionId: predictionId,
        videoUrl: undefined,
        videoRetryCount: 0,
        videoRetryAfter: undefined,
        videoProvider: "hypereal",
      };
      await updateSceneAtIndex(supabase, generationId, idx, scenes[idx]);

      // Return processing status immediately to avoid Edge Function timeout
      console.log(`[IMG-REGEN] Scene ${scene.number}: Returning processing status, frontend will poll video phase`);
      return jsonResponse({ success: true, status: "processing", scene: scenes[idx] });
    }

    // =============== PHASE 5: FINALIZE ===============
    if (phase === "finalize") {
      // Collect all video URLs from scenes
      const videoUrls = scenes.filter((s) => s.videoUrl).map((s) => s.videoUrl as string);
      // Keep first as legacy field, but also return all clips
      const finalVideoUrl = videoUrls[0] || "";

      // Mark complete
      await supabase
        .from("generations")
        .update({
          status: "complete",
          progress: 100,
          completed_at: new Date().toISOString(),
          scenes,
          video_url: finalVideoUrl,
        })
        .eq("id", generationId);

      await supabase.from("projects").update({ status: "complete" }).eq("id", generation.project_id);

      // Save permanent thumbnail
      try {
        const firstSceneWithImage = scenes.find((s) => s.imageUrl);
        if (firstSceneWithImage?.imageUrl) {
          const imageResponse = await fetch(firstSceneWithImage.imageUrl);
          if (imageResponse.ok) {
            const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());
            const thumbnailPath = `${generation.user_id}/${generation.project_id}/thumbnail-${Date.now()}.png`;
            await supabase.storage
              .from("project-thumbnails")
              .upload(thumbnailPath, imageBytes, { contentType: "image/png", upsert: true });
            const { data: publicUrlData } = supabase.storage
              .from("project-thumbnails")
              .getPublicUrl(thumbnailPath);
            if (publicUrlData?.publicUrl) {
              await supabase
                .from("projects")
                .update({ thumbnail_url: publicUrlData.publicUrl })
                .eq("id", generation.project_id);
              console.log(`[FINALIZE] Cinematic thumbnail saved: ${publicUrlData.publicUrl}`);
            }
          }
        }
      } catch (thumbErr) {
        console.error("[FINALIZE] Failed to save cinematic thumbnail:", thumbErr);
      }

      // Title from project
      const { data: project } = await supabase
        .from("projects")
        .select("id, title")
        .eq("id", generation.project_id)
        .maybeSingle();

      return jsonResponse({
        success: true,
        projectId: generation.project_id,
        generationId,
        title: project?.title || "Untitled Cinematic",
        scenes,
        finalVideoUrl,
        allVideoUrls: videoUrls, // All generated clips
      });
    }

    return jsonResponse({ error: "Invalid phase" }, { status: 400 });
  } catch (error) {
    console.error("Cinematic generation error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Update project and generation status to 'error' to prevent zombie generations
    try {
      const genId = parsedGenerationId;
      if (genId) {
        const supabaseUrl = Deno.env.get("SUPABASE_URL");
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (supabaseUrl && supabaseKey) {
          const sb = createClient(supabaseUrl, supabaseKey);
          const { data: gen } = await sb.from("generations").select("project_id").eq("id", genId).maybeSingle();

          await sb
            .from("generations")
            .update({
              status: "error",
              error_message: errorMessage,
            })
            .eq("id", genId);

          if (gen?.project_id) {
            await sb.from("projects").update({ status: "error" }).eq("id", gen.project_id);
          }
          console.log(`[ERROR-HANDLER] Updated generation ${genId} and project to error status`);
        }
      }
    } catch (cleanupErr) {
      console.error("[ERROR-HANDLER] Failed to update error status:", cleanupErr);
    }

    return jsonResponse(
      {
        success: false,
        error: errorMessage,
      },
      { status: 500 },
    );
  }
});
