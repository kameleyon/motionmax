/**
 * Shared prompt constants, style mappings, and pure helper functions.
 * Ported from supabase/functions/generate-video/index.ts — values are
 * intentionally identical to keep parity between the Edge Function and
 * the Node.js worker.
 *
 * This file contains NO API calls — only constants, types, and pure functions.
 */

// ────────────────────────────── Types ──────────────────────────────

export interface ImageDimensions {
  width: number;
  height: number;
  aspectRatio: string;
}

// ────────────────────────── Style Prompts ──────────────────────────

export const STYLE_PROMPTS: Record<string, string> = {
  minimalist: `Minimalist illustration using thin monoline black line art. Clean Scandinavian / modern icon vibe. Large areas of white negative space. Muted pastel palette (sage green, dusty teal, soft gray-blue, warm mustard) with flat fills only (no gradients). Centered composition, crisp edges, airy spacing, high resolution.`,
  doodle: `Urban Minimalist Doodle style. Creative, Dynamic, and Catchy Flat 2D vector illustration with indie comic aesthetic. Make the artwork detailed, highly dynamic, catchy and captivating, and filling up the entire page. Add Words to illustrate the artwork. LINE WORK: Bold, consistent-weight black outlines (monoline) that feel hand-drawn but clean, with slightly rounded terminals for a friendly, approachable feel. COLOR PALETTE: Muted Primary tones—desaturated dusty reds, sage greens, mustard yellows, and slate blues—set against a warm, textured background. CHARACTER DESIGN: Object-Head surrealism with symbolic objects creating an instant iconographic look that is relatable yet stylized. TEXTURING: Subtle Lo-Fi distressing with light paper grain, tiny ink flecks, and occasional print misalignments where color doesn't perfectly hit the line. COMPOSITION: Centralized and Floating—main subject grounded surrounded by a halo of smaller floating icons representing the theme without cluttering. Technical style: Flat 2D Vector Illustration, Indie Comic Aesthetic. Vibe: Lo-fi, Chill, Entrepreneurial, Whimsical. Influences: Modern editorial illustration, 90s streetwear graphics, and Lofi Girl aesthetics.`,
  stick: `Hand-drawn stick figure comic style. Crude, expressive black marker lines on a pure white. Extremely simple character designs (circles for heads, single lines for limbs). No fill colors—strictly black and white line art. Focus on humor and clarity. Rough, sketchy aesthetic similar to 'XKCD' or 'Wait But Why'. Imperfect circles and wobbly lines to emphasize the handmade, napkin-sketch quality. The background MUST be solid pure white (#FFFFFF)—just clean solid white. NEGATIVE PROMPT: Do NOT invent or describe any human character's race, ethnicity, skin tone, hair, age, gender, clothing, or facial features.`,
  realistic: `Photorealistic cinematic photography. 4K UHD, HDR, 8k resolution. Shot on 35mm lens with shallow depth of field (bokeh) to isolate subjects. Hyper-realistic textures, dramatic studio lighting with rim lights. Natural skin tones and accurate material physics. Look of high-end stock photography or a Netflix documentary. Sharp focus, rich contrast, and true-to-life color grading. Unreal Engine 5 render quality, like shot on Kodak Gold 400 film tones.`,
  anime: `Expressive Modern Manga-Style Sketchbook. An expressive modern manga-style sketchbook illustration. Anatomy: Large-eye expressive anime/manga influence focusing on high emotional impact and kawaii but relatable proportions. Line Work: Very loose, visible rough sketch lines—looks like a final drawing made over a messy pencil draft. Coloring: Natural tones with focus on skin-glow, painterly approach with visible thick brush strokes. Vibe: Cozy, chaotic, and sentimental slice-of-life moments. Features loose sketchy digital pencil lines and painterly slice-of-life aesthetic. High-detail facial expressions with large emotive eyes. Visible brush strokes. Set in detailed, slightly messy environment that feels lived-in. Cozy, relatable, and artistically sophisticated.`,
  "3d-pixar": `Cinematic 3D Animation. A stunning 3D cinematic animation-style render in the aesthetic of modern Disney-Pixar films. Surface Geometry: Squash and Stretch—appealing rounded shapes with soft exaggerated features, avoiding sharp angles unless part of mechanical design. Material Science: Subsurface Scattering—that Disney glow where light slightly penetrates the surface like real skin or wax, textures are stylized realism with soft fur, knit fabrics, or polished plastic. Lighting Design: Three-Point Cinematic—strong key light, soft fill light to eliminate harsh shadows, bright rim light (backlight) creating glowing silhouette separating from background. Eyes: The Soul Focal Point—large, highly detailed eyes with realistic specular highlights and deep iris colors making character feel sentient and emotive. Atmosphere: Volumetric Depth—light fog, dust motes, or god rays creating sense of physical space, background has soft bokeh blur keeping focus on subject. High-detail textures, expressive large eyes, soft rounded features. Vibrant saturated colors with high-end subsurface scattering on all surfaces. Rendered in 8k using Octane, shallow depth of field, whimsical softly blurred background. Masterpiece quality, charming, tactile, and highly emotive. High Resolution, High Contrast, High Definition, like shot on Kodak Gold 400 film tones.`,
  claymation: `Handcrafted Digital Clay. A high-detail 3D claymation-style render. Material Texture: Matte & Tactile—surfaces must show subtle, realistic imperfections like tiny thumbprints, slight molding creases, and a soft matte finish that mimics polymer clay (like Sculpey or Fimo). Lighting: Miniature Macro Lighting—soft, high-contrast studio lighting that makes the subject look like a small physical object, includes Rim Lighting to make the edges glow and deep, soft-edge shadows. Proportions: Chunky & Appealing—thick, rounded limbs and exaggerated squashy features, avoid any sharp digital edges, everything should look like it was rolled between two palms. Atmosphere: Depth of Field—heavy background blur (bokeh) essential to sell the small toy scale, making the subject pop as the central focus. Color Palette: Saturated & Playful—bold, solid primary colors that look like they came straight out of a clay pack, avoiding complex gradients. 8k resolution, Octane Render, masterpiece quality.`,
  sketch: `Emphasize the paper cutout effect with a strong dark 3D backdrop shadow. Hand-drawn stick figure comic style, but with a polished, clean digital finish. Smooth, expressive black marker lines on pure white. Extremely simple character designs (perfect single-stroke circles for heads, solid single lines for limbs). Avoid sketchy, wobbly, or overlapping rough lines; use confident, clean monoline strokes instead. Strictly black and white line art. High contrast black and white ONLY, no other color. Focus on humor and clarity while maintaining a neat professional aesthetic. Crucial Effect: Apply strong "paper cutout" 3D drop shadows behind the characters and objects to make them pop off the page like a diorama. Ensure natural orientation and correct anatomy (two arms, two legs). Make it detailed, highly creative, extremely expressive, and dynamic, while keeping character consistency. Include environment or setting of the scene so the user can see where the scene is happening. Make on a plain solid white background. ANIMATION RULES (CRITICAL): NO lip-sync talking animation - characters should NOT move their mouths as if speaking. Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry. Body movement IS allowed: walking, running, gesturing, pointing, reacting. Environment animation IS allowed: wind, particles, camera movement, lighting changes. Static poses with subtle breathing/idle movement are preferred for dialogue scenes. Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement. NEGATIVE PROMPT: Do NOT invent or describe any human character's race, ethnicity, skin tone, hair, age, gender, clothing, or facial features.`,
  caricature: `Humorous caricature illustration inspired by the visual aesthetic of MAD Magazine cover art — bold, dynamic, richly painted with energetic brushwork. Highly exaggerated facial features: oversized heads, giant expressive eyes, huge noses, rubbery lips, tiny bodies. Vivid, saturated color palette with loose oil-painting brushstrokes and strong ink outlines. Characters are dramatic, larger-than-life, and bursting with personality. Dynamic cinematic compositions with expressive poses and exaggerated reactions. The painterly style has visible confident brushwork, vibrant shadows, and punchy highlights. CRITICAL: Do NOT include the MAD magazine logo or title text anywhere in the image. No "MAD" lettering, no magazine masthead, no title banner.`,
  moody: `Moody monochrome indie comic illustration in black, white, and grays. Thick clean outlines with hand-inked crosshatching and scratchy pen texture for shading. Slightly uneven line quality like traditional ink on paper. Cute-but-unsettling character design: oversized head, huge simple eyes empty, tiny mouth, minimal nose; small body with simplified hands. Cinematic centered framing, quiet tension, lots of flat mid-gray tones. Subtle paper grain and faint smudges. Background is minimal but grounded with simple interior props drawn in the same inked style. Overall vibe: moody, not happy, melancholic, eerie, storybook graphic novel panel, high contrast, no color. 2D ink drawing. NEGATIVE PROMPT: Do NOT invent or describe any human character's race, ethnicity, skin tone, hair, age, gender, clothing, or facial features.`,
  storybook: `3D PaperCut Rough Sketchy storybook hand-drawn ink style. Hand-drawn black ink outlines with visible rough sketch construction lines, slightly uneven strokes, and occasional line overlap (imperfect but intentional). Bold vivid natural color palette. Crosshatching and scribbly pen shading for depth and texture, especially in shadows and on fabric folds. Bold Vivid Color. Edges slightly loose (not crisp). Cartoon-proportioned character design: slightly exaggerated features (large eyes, long limbs, expressive faces, big head), but grounded in believable anatomy and posture. Background extremely detailed: textured walls, props with sketchy detail, and atmospheric depth. Subtle grain + ink flecks for a handmade print feel. Cinematic framing, shallow depth cues, soft focus in far background. Editorial illustration / indie animation concept art aesthetic. Charming, cozy, slightly messy, richly textured, high detail, UHD. no photorealism.`,
  crayon: `Cute childlike crayon illustration on clean white paper background. Waxy crayon / oil pastel scribble texture with visible stroke marks and uneven fill (messy on purpose). Simple rounded shapes, thick hand-drawn outlines, minimal details, playful proportions (big head, small body). Bright limited palette like orange + blue + yellow, rough shading and light smudges like real crayons on paper. Simple cheerful scene, lots of white space, friendly smiley faces. Looks like kindergarten drawing scanned into computer. High resolution. No vector, no clean digital painting, no 3D, no realism, no gradients, no sharp edges.`,
  chalkboard: `A hand-drawn chalkboard illustration style characterized by voluntarily imperfect, organic lines that capture the authentic vibe of human handwriting. Unlike rigid digital art, the strokes feature subtle wobbles, varying pressure, and natural endpoints, mimicking the tactile feel of chalk held by a steady hand. The background is a deep, dark slate grey, almost black, with a very subtle, fine-grain slate texture that suggests a fresh, clean surface rather than a dusty one. The line work features crisp, monoline chalk outlines that possess the dry, slightly grainy texture of real chalk and are drawn with authentic vibe of hand-drawing, yet ensuring a confident and legible look. The color palette utilizes high-contrast stark white. The rendering is flat and illustrative, with solid chalk fills textured via diagonal hatching or stippling to let the dark background show through slightly, creating a vibe that is smart, academic, and hand-crafted yet thoroughly professional. No other colors than white.`,
  lego: `A hyper-realistic, macro-photography 3D CGI render of a Lego diorama. Extreme close-up, low-angle dynamic perspective. The entire scene is built of recognizable, glossy injection-molded plastic Lego bricks with prominent studs. Characters are in rigid but epic, dynamic poses. Emphasize macro micro-details: subtle surface scratches, fingerprints, and edge highlights on the plastic. Intense cinematic rim lighting, heavy shadows, high contrast, and volumetric glowing particle effects (fire embers and lightning sparks). Extreme shallow depth of field with heavy, cinematic background bokeh completely blurring the stadium crowd. The lighting is stylized and dramatic, resembling a high-end, high quality, intrisinctly detailed, official Lego movie close-up.`,
  cardboard: `A high-quality, highly dynamic visualization social media explainer video still featuring a tabletop miniature diorama. The scene is populated by very detailed, expressive claymation-style figurines representing a diverse group of people based on the content context. The figures must meet distinct, clearly defined ethnic features based on the content context, when it comes to skin tones, and highly textured matching specific cultural hairstyles. It is detailed, high contrast, high resolution, high definition, They are dressed in carefully crafted miniature clothing and in the content cultural context. The environment, structures, and props are constructed from clean, precise corrugated cardboard, kraft paper, alluminum foil and light wood, utilizing thin visible wires or strings to suspend floating elements. Bold, black, physical 3D text and symbolic graphic props (like arrows, charts, or currency signs) are integrated directly into the physical space as tangible objects. Set against a bright, pristine white seamless studio background with soft, realistic tabletop shadows. The overall aesthetic is a premium, professional tactile miniature world, blending expressive, detailed clay characters with crisp, organized papercraft environments.`,
  babie: `Highly expressive Barbie-style extremely close-up portrait, glamorous fashion doll with exaggerated annoyed / disgusted expression, scrunched nose, curled upper lip, asymmetrical pout, narrowed half-lidded eyes, deeply unimpressed "are you serious?" face, smooth glossy plastic skin, sharp makeup, dramatic lashes, sleek rooted messy disheveled hair with flyaway chaos, cinematic toy, extreme close-up, shallow depth of field, crisp facial definition, high-detail plastic texture, soft but clear lighting, luxury Barbie realism, attitude, annoyed bratty elegance, iconic doll face, unhinged enough to feel alive. Ultra High Definition, HDR, with a Kodak Gold 400 film tones`,
};

// ──────────────────── Text Overlay Styles ──────────────────────────

/** Styles that include burned-in text overlays on images. */
export const TEXT_OVERLAY_STYLES: string[] = ["minimalist", "doodle", "stick"];

// ──────────────── Content Compliance Instruction ───────────────────

export const CONTENT_COMPLIANCE_INSTRUCTION = `
CONTENT POLICY (MANDATORY):
- Generate only family-friendly, appropriate content
- No explicit violence, gore, or disturbing imagery
- No sexual or adult content
- No hate speech, discrimination, or offensive stereotypes
- No content promoting illegal activities
- Keep all content suitable for general audiences

### TTS CONTENT FILTER SAFETY (CRITICAL) ###
The voiceover text will be read aloud by a Text-to-Speech engine with strict content safety filters.
You MUST avoid ANY words or onomatopoeia that could trigger these filters, including but not limited to:
- BANNED WORDS: "BOUM", "BOOM", "BANG", "POW", "CRASH", "KABOOM", "SLASH", "STAB", "SMASH", "BLAST", "EXPLODE", "EXPLOSION", "BLOW UP", "SHOOT", "SHOT", "KILL", "DIE", "DEAD", "BLOOD", "GUN", "BOMB", "ATTACK", "DESTROY", "MURDER", "WEAPON"
- This applies to ALL languages including Haitian Creole, French, Spanish, etc.
- Instead of violent/explosive onomatopoeia, use SAFE dramatic alternatives like: "Suddenly...", "In a flash...", "In an instant...", "Everything changed...", "Toudenkou..." (Creole), "At that very moment..."
- NEVER use ALL-CAPS onomatopoeia or sound effects in voiceover text
- Write narration that is dramatic but uses DESCRIPTIVE language, not sound-effect words

### HISTORICAL, CULTURAL & VISUAL ACCURACY (CRITICAL) ###
You are generating visual prompts that will create illustrations. You MUST ensure absolute accuracy:
- **Historical accuracy**: If the content covers a specific time period (e.g. England 1400s), ALL visual elements must match that era — architecture, clothing, weapons, tools, furniture, hairstyles, technology. Do NOT mix elements from different centuries or regions.
- **Geographic accuracy**: Landscapes, vegetation, weather, and urban design must match the real-world location depicted.
- **Ethnic & facial accuracy**: Characters must reflect the correct ethnicity, skin tone, facial features, hair texture, and body type for the culture/region described.
- **Cultural accuracy**: Clothing, jewelry, rituals, food, instruments, religious symbols, and customs must be culturally authentic and specific.
- **Name & spelling accuracy**: Proper nouns, place names, historical figures, and brand names must be spelled correctly in voiceover and visual prompts.
- **Color & material accuracy**: Use historically/culturally accurate colors for flags, uniforms, traditional garments, heraldry, and national symbols.
- **Context coherence**: Every object, person, and setting must belong to the same time, place, and cultural context. No anachronisms.
- When unsure, use the MOST COMMONLY DOCUMENTED historical/cultural representation.
`;

// ──────────────── Cinematic Style Overrides ────────────────────────

/** Styles that differ for the cinematic pipeline. */
const CINEMATIC_STYLE_OVERRIDES: Record<string, string> = {
  moody: `Moody monochrome stylized 3D paper cutout indie illustration in black, white, and grays. The scene is constructed like a shallow diorama, using distinct, physically separated layers of thick paper that cast realistic drop shadows on one another to create tangible depth. Each paper layer features thick clean outlines with hand-inked crosshatching and scratchy pen texture for shading, maintaining a slightly uneven line quality like traditional ink on paper. Cute-but-unsettling eerie character design as the central cutout: oversized head, huge blank empty simple eyes, tiny mouth, minimal to nonose; small body with simplified hands and shape. Cinematic centered framing, quiet tension, utilizing varying shades of flat mid-gray paper stock. Visible tactile paper grain, slightly curled edges, and faint ink smudges on the surfaces. The background is minimal but expressive, creative, and grounded, with simple interior props crafted as separate paper pieces drawn in the same inked style. Overall vibe: moody, not happy, unsettling, melancholic, eerie, 3D pop-up storybook graphic novel, high contrast, high definition, high resolution, no color.`,
};

// ──────────────── Style Integrity Enforcement ──────────────────────

/**
 * Suffix appended to every non-realistic style prompt. Forces the
 * image generator to render EVERY subject (humans included) in the
 * chosen style — fixes the case where a cardboard / clay / lego /
 * doodle / etc. scene gets a photorealistic human stitched into the
 * frame because the style only described the environment.
 *
 * Example failure mode caught by this: a "cardboard" image where a
 * real photographic woman was bending over the cardboard diorama,
 * because nothing told the model "the human is also cardboard."
 */
const STYLE_INTEGRITY_SUFFIX = ` STYLE INTEGRITY (CRITICAL — NON-NEGOTIABLE): EVERY subject in the frame, including humans, hands, faces, clothing, hair, animals, and any background figures, MUST be rendered fully in this art style. NO photorealistic humans. NO real-life people. NO live-action photography. NO photographic skin texture. NO mixing of stylized environments with realistic figures. If a person appears in the scene, they are rendered in the same medium as the rest of the image (clay, cardboard, lego brick, doodle, anime, etc. — whatever the style dictates). The image must read as a single cohesive artistic medium with zero hybrid live-action / stylized splits.`;

/**
 * Negative-prompt tokens appended to video / image generation requests
 * for non-realistic styles. Mirrors STYLE_INTEGRITY_SUFFIX from the
 * negative-side: explicitly tells the model what to suppress.
 */
const STYLE_INTEGRITY_NEGATIVES = "photorealistic, realistic human, real person, live action, live-action, photograph, photographic, real skin, naturalistic skin texture, real face, real eyes, photographic portrait, hybrid photo and illustration, mixing realistic person with stylized scene, real human bending over diorama, real hand reaching into miniature";

/** The single style that is INTENDED to be photorealistic; skip the
 *  integrity suffix for it. Centralized here so future realistic-leaning
 *  styles (e.g. "documentary", "stock-photo") can be added by name. */
const REALISTIC_STYLES = new Set<string>(["realistic"]);

/** True iff this style key opts INTO photorealism (so we should NOT
 *  inject the anti-realism suffix / negative prompt). */
export function isRealisticStyle(style: string): boolean {
  return REALISTIC_STYLES.has(style.toLowerCase());
}

// ──────────────────── Helper Functions ─────────────────────────────

/** Resolve a style key to the full visual-prompt string.
 *  Pass projectType to get cinematic-specific overrides.
 *  Non-realistic styles automatically get the STYLE_INTEGRITY suffix
 *  appended so the image model can't slip in real humans on a
 *  stylized environment. */
export function getStylePrompt(style: string, customStyle?: string, projectType?: string): string {
  if (style === "custom" && customStyle) {
    // Custom user-supplied prompt: trust the user. They opted in to
    // whatever they wrote — no suffix, no nanny.
    return customStyle;
  }
  const key = style.toLowerCase();
  let base: string;
  if (projectType === "cinematic" && CINEMATIC_STYLE_OVERRIDES[key]) {
    base = CINEMATIC_STYLE_OVERRIDES[key];
  } else {
    base = STYLE_PROMPTS[key] || style;
  }
  // Realistic styles want photorealism; everything else needs the
  // anti-realism enforcement to keep the medium cohesive.
  if (isRealisticStyle(key)) return base;
  return base + STYLE_INTEGRITY_SUFFIX;
}

/** Negative-prompt tokens for video / image generation that vary by
 *  style. Realistic style returns empty string; every other style
 *  gets the anti-realism token list. Callers should comma-join their
 *  base negative prompt with this. */
export function getStyleNegativePrompt(style: string, customStyle?: string): string {
  if (style === "custom" && customStyle) return ""; // user-driven; no nanny
  if (isRealisticStyle(style)) return "";
  return STYLE_INTEGRITY_NEGATIVES;
}

/** Return pixel dimensions and aspect-ratio string for a given format. */
export function getImageDimensions(format: string): ImageDimensions {
  switch (format) {
    case "portrait":
      return { width: 816, height: 1440, aspectRatio: "9:16" };
    case "square":
      return { width: 1024, height: 1024, aspectRatio: "1:1" };
    default:
      return { width: 1440, height: 816, aspectRatio: "16:9" }; // landscape
  }
}

// ──────────────────── JSON Extraction ──────────────────────────────

/**
 * Repair a JSON string by escaping unescaped double-quotes that appear inside
 * string values.  Uses a lightweight state machine instead of a regex so it
 * handles arbitrary value content correctly.
 */
function repairUnescapedQuotes(json: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        inString = true;
        result += ch;
        continue;
      }

      // Determine whether this quote closes the string or is unescaped content.
      // A closing quote is followed (ignoring whitespace) by : , ] } or EOF.
      const rest = json.slice(i + 1).trimStart();
      const isClosing = rest.length === 0 || /^[:,\]}]/.test(rest);

      if (isClosing) {
        inString = false;
        result += ch;
      } else {
        // Unescaped quote inside a string value — escape it.
        result += '\\"';
      }
      continue;
    }

    result += ch;
  }

  return result;
}

/** Repair "Bad escaped character" failures.
 *
 *  LLMs occasionally produce strings like:
 *    "title": "Vini Jr: Twòn an ak Orizo a — Lavni \é Lejand"
 *  where `\é` is an invalid JSON escape (only \" \\ \/ \b \f \n \r \t \uXXXX
 *  are legal). They also sometimes inline literal control characters
 *  (raw \n, \t, \r) inside string values, which JSON.parse rejects.
 *
 *  This walker tracks "am I inside a string?" via state, and when inside
 *  a string:
 *    - A backslash NOT followed by a valid escape char gets doubled
 *      (`\é` → `\\é`, which JSON.parse decodes back to literal `\é`)
 *    - Raw control chars (\n, \r, \t) get escaped (\n → \\n etc.)
 *  Outside strings, content passes through unchanged. */
function repairBadEscapes(json: string): string {
  const VALID_ESCAPE_NEXT = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
  let result = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (!inString) {
      if (ch === '"') {
        inString = true;
        result += ch;
        continue;
      }
      result += ch;
      continue;
    }
    // We're inside a string value.
    if (ch === "\\") {
      const next = json[i + 1];
      if (next !== undefined && VALID_ESCAPE_NEXT.has(next)) {
        // Valid escape — pass both chars through verbatim.
        result += ch + next;
        i++;
        continue;
      }
      // Invalid escape — double the backslash so JSON.parse sees a
      // literal `\` followed by the next char (which then continues
      // the string normally).
      result += "\\\\";
      continue;
    }
    if (ch === '"') {
      inString = false;
      result += ch;
      continue;
    }
    // Escape raw control characters that aren't legal inside JSON
    // strings. Anything else (including unicode/accented chars) is
    // passed through.
    if (ch === "\n") { result += "\\n"; continue; }
    if (ch === "\r") { result += "\\r"; continue; }
    if (ch === "\t") { result += "\\t"; continue; }
    result += ch;
  }
  return result;
}

/** Return the top-level keys of an object (up to 12) for debug logging. */
function getTopLevelKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value as Record<string, unknown>).slice(0, 12);
}

/**
 * Extract and parse a JSON object from an LLM response that may be
 * wrapped in markdown code fences or contain trailing commas / truncation.
 */
export function extractJsonFromLLMResponse(raw: string, label: string): unknown {
  if (!raw || typeof raw !== "string") {
    console.error(`[JSON_EXTRACT] ${label}: empty or non-string input`);
    throw new Error(`No content to parse for ${label}`);
  }

  console.log(`[JSON_EXTRACT] ${label}: starting parse`, {
    rawLength: raw.length,
    previewStart: raw.substring(0, 220),
    previewEnd: raw.substring(Math.max(0, raw.length - 220)),
  });

  let content = raw.trim();

  // Step 0: Strip <think> reasoning tags (Gemini/DeepSeek)
  if (content.includes("<think>")) {
    content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  }

  // Step 1: Strip markdown code fences
  if (content.startsWith("```")) {
    content = content
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .trim();
  }

  // Step 2: Extract JSON between first { and last }
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    console.error(
      `[JSON_EXTRACT] ${label}: no JSON object found. Raw (first 500 chars):`,
      content.substring(0, 500),
    );
    throw new Error(`Failed to parse ${label}: no JSON object found in response`);
  }
  content = content.slice(firstBrace, lastBrace + 1);

  // Step 3: Fix trailing commas (common LLM issue)
  content = content.replace(/,\s*([\]}])/g, "$1");

  // Step 4: Try parsing
  try {
    const parsed = JSON.parse(content);
    console.log(`[JSON_EXTRACT] ${label}: parse success on first attempt`, {
      normalizedLength: content.length,
      topLevelKeys: getTopLevelKeys(parsed),
    });
    return parsed;
  } catch (firstError) {
    console.warn(
      `[JSON_EXTRACT] ${label}: first parse attempt failed:`,
      (firstError as Error).message,
    );

    // Step 5: Attempt to fix truncated JSON by closing open structures
    let fixedContent = content;
    const openBraces = (fixedContent.match(/{/g) || []).length;
    const closeBraces = (fixedContent.match(/}/g) || []).length;
    const openBrackets = (fixedContent.match(/\[/g) || []).length;
    const closeBrackets = (fixedContent.match(/]/g) || []).length;

    // Remove trailing partial content from truncated JSON:
    // 1. If truncated mid-string-value, find the last complete key-value pair
    // 2. Strip everything after the last complete object/array element

    // Close any unclosed string (truncated mid-value)
    const quoteCount = (fixedContent.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      // Odd quotes = truncated inside a string. Find last complete line and trim
      const lastNewline = fixedContent.lastIndexOf("\n");
      if (lastNewline > fixedContent.length * 0.5) {
        fixedContent = fixedContent.substring(0, lastNewline);
      } else {
        fixedContent += '"';
      }
    }

    // Remove trailing partial key-value pairs and objects
    fixedContent = fixedContent
      .replace(/,\s*\{[^}]*$/, "")        // trailing partial object in array
      .replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "")  // trailing partial key-value
      .replace(/,\s*$/, "");                // trailing comma

    // Close unclosed brackets and braces
    for (let i = 0; i < openBrackets - closeBrackets; i++) fixedContent += "]";
    for (let i = 0; i < openBraces - closeBraces; i++) fixedContent += "}";

    try {
      const result = JSON.parse(fixedContent);
      console.log(`[JSON_EXTRACT] ${label}: recovered truncated JSON successfully`, {
        fixedLength: fixedContent.length,
        topLevelKeys: getTopLevelKeys(result),
      });
      return result;
    } catch (secondError) {
      // Step 6: State-machine repair for unescaped double-quotes inside string values.
      // LLMs writing rich visual prompts sometimes embed literal " inside strings,
      // producing invalid JSON.  repairUnescapedQuotes() fixes this without a library.
      try {
        const sanitized = repairUnescapedQuotes(fixedContent);
        const result = JSON.parse(sanitized);
        console.log(`[JSON_EXTRACT] ${label}: recovered via state-machine quote repair`, {
          sanitizedLength: sanitized.length,
          topLevelKeys: getTopLevelKeys(result),
        });
        return result;
      } catch (thirdError) {
        // Step 7: Repair "Bad escaped character" — LLM emitted a `\`
        // not followed by a valid JSON escape (e.g. `\é`, `\g`, `\.`).
        // Sanitize by walking the string, when INSIDE a JSON string
        // value, doubling any `\` that doesn't precede one of
        // ["\\/bfnrtu]. Also escapes literal control chars (\n, \t,
        // \r) that the LLM occasionally inlines unescaped.
        try {
          const escapeRepaired = repairBadEscapes(fixedContent);
          const result = JSON.parse(escapeRepaired);
          console.log(`[JSON_EXTRACT] ${label}: recovered via escape repair`, {
            repairedLength: escapeRepaired.length,
            topLevelKeys: getTopLevelKeys(result),
          });
          return result;
        } catch (fourthError) {
          console.error(
            `[JSON_EXTRACT] ${label}: all parse attempts failed.`,
            `\nFirst error: ${(firstError as Error).message}`,
            `\nSecond error: ${(secondError as Error).message}`,
            `\nThird error: ${(thirdError as Error).message}`,
            `\nFourth error: ${(fourthError as Error).message}`,
            `\nRaw content (first 800 chars): ${raw.substring(0, 800)}`,
            `\nRaw content (last 300 chars): ${raw.substring(Math.max(0, raw.length - 300))}`,
          );
          throw new Error(`Failed to parse ${label}: invalid JSON from LLM`);
        }
      }
    }
  }
}
