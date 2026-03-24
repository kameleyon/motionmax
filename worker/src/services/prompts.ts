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
  stick: `Hand-drawn stick figure comic style. Crude, expressive black marker lines on a pure white. Extremely simple character designs (circles for heads, single lines for limbs). No fill colors—strictly black and white line art. Focus on humor and clarity. Rough, sketchy aesthetic similar to 'XKCD' or 'Wait But Why'. Imperfect circles and wobbly lines to emphasize the handmade, napkin-sketch quality. The background MUST be solid pure white (#FFFFFF)—just clean solid white.`,
  realistic: `Photorealistic cinematic photography. 4K UHD, HDR, 8k resolution. Shot on 35mm lens with shallow depth of field (bokeh) to isolate subjects. Hyper-realistic textures, dramatic studio lighting with rim lights. Natural skin tones and accurate material physics. Look of high-end stock photography or a Netflix documentary. Sharp focus, rich contrast, and true-to-life color grading. Unreal Engine 5 render quality.`,
  anime: `Expressive Modern Manga-Style Sketchbook. An expressive modern manga-style sketchbook illustration. Anatomy: Large-eye expressive anime/manga influence focusing on high emotional impact and kawaii but relatable proportions. Line Work: Very loose, visible rough sketch lines—looks like a final drawing made over a messy pencil draft. Coloring: Natural tones with focus on skin-glow, painterly approach with visible thick brush strokes. Vibe: Cozy, chaotic, and sentimental slice-of-life moments. Features loose sketchy digital pencil lines and painterly slice-of-life aesthetic. High-detail facial expressions with large emotive eyes. Visible brush strokes. Set in detailed, slightly messy environment that feels lived-in. Cozy, relatable, and artistically sophisticated.`,
  "3D Pix": `Cinematic 3D Animation. A stunning 3D cinematic animation-style render in the aesthetic of modern Disney-Pixar films. Surface Geometry: Squash and Stretch—appealing rounded shapes with soft exaggerated features, avoiding sharp angles unless part of mechanical design. Material Science: Subsurface Scattering—that Disney glow where light slightly penetrates the surface like real skin or wax, textures are stylized realism with soft fur, knit fabrics, or polished plastic. Lighting Design: Three-Point Cinematic—strong key light, soft fill light to eliminate harsh shadows, bright rim light (backlight) creating glowing silhouette separating from background. Eyes: The Soul Focal Point—large, highly detailed eyes with realistic specular highlights and deep iris colors making character feel sentient and emotive. Atmosphere: Volumetric Depth—light fog, dust motes, or god rays creating sense of physical space, background has soft bokeh blur keeping focus on subject. High-detail textures, expressive large eyes, soft rounded features. Vibrant saturated colors with high-end subsurface scattering on all surfaces. Rendered in 8k using Octane, shallow depth of field, whimsical softly blurred background. Masterpiece quality, charming, tactile, and highly emotive.`,
  "3d-pixar": `Cinematic 3D Animation. A stunning 3D cinematic animation-style render in the aesthetic of modern Disney-Pixar films. Surface Geometry: Squash and Stretch—appealing rounded shapes with soft exaggerated features, avoiding sharp angles unless part of mechanical design. Material Science: Subsurface Scattering—that Disney glow where light slightly penetrates the surface like real skin or wax, textures are stylized realism with soft fur, knit fabrics, or polished plastic. Lighting Design: Three-Point Cinematic—strong key light, soft fill light to eliminate harsh shadows, bright rim light (backlight) creating glowing silhouette separating from background. Eyes: The Soul Focal Point—large, highly detailed eyes with realistic specular highlights and deep iris colors making character feel sentient and emotive. Atmosphere: Volumetric Depth—light fog, dust motes, or god rays creating sense of physical space, background has soft bokeh blur keeping focus on subject. High-detail textures, expressive large eyes, soft rounded features. Vibrant saturated colors with high-end subsurface scattering on all surfaces. Rendered in 8k using Octane, shallow depth of field, whimsical softly blurred background. Masterpiece quality, charming, tactile, and highly emotive.`,
  claymation: `Handcrafted Digital Clay. A high-detail 3D claymation-style render. Material Texture: Matte & Tactile—surfaces must show subtle, realistic imperfections like tiny thumbprints, slight molding creases, and a soft matte finish that mimics polymer clay (like Sculpey or Fimo). Lighting: Miniature Macro Lighting—soft, high-contrast studio lighting that makes the subject look like a small physical object, includes Rim Lighting to make the edges glow and deep, soft-edge shadows. Proportions: Chunky & Appealing—thick, rounded limbs and exaggerated squashy features, avoid any sharp digital edges, everything should look like it was rolled between two palms. Atmosphere: Depth of Field—heavy background blur (bokeh) essential to sell the small toy scale, making the subject pop as the central focus. Color Palette: Saturated & Playful—bold, solid primary colors that look like they came straight out of a clay pack, avoiding complex gradients. 8k resolution, Octane Render, masterpiece quality.`,
  sketch: `Emphasize the paper cutout effect with a strong dark 3D backdrop shadow. Hand-drawn stick figure comic style, but with a polished, clean digital finish. Smooth, expressive black marker lines on pure white. Extremely simple character designs (perfect single-stroke circles for heads, solid single lines for limbs). Avoid sketchy, wobbly, or overlapping rough lines; use confident, clean monoline strokes instead. Strictly black and white line art. High contrast black and white ONLY, no other color. Focus on humor and clarity while maintaining a neat professional aesthetic. Crucial Effect: Apply strong "paper cutout" 3D drop shadows behind the characters and objects to make them pop off the page like a diorama. Ensure natural orientation and correct anatomy (two arms, two legs). Make it detailed, highly creative, extremely expressive, and dynamic, while keeping character consistency. Include environment or setting of the scene so the user can see where the scene is happening. Make on a plain solid white background. ANIMATION RULES (CRITICAL): NO lip-sync talking animation - characters should NOT move their mouths as if speaking. Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry. Body movement IS allowed: walking, running, gesturing, pointing, reacting. Environment animation IS allowed: wind, particles, camera movement, lighting changes. Static poses with subtle breathing/idle movement are preferred for dialogue scenes. Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement.`,
  caricature: `Humorous caricature illustration inspired by the visual aesthetic of MAD Magazine cover art — bold, dynamic, richly painted with energetic brushwork. Highly exaggerated facial features: oversized heads, giant expressive eyes, huge noses, rubbery lips, tiny bodies. Vivid, saturated color palette with loose oil-painting brushstrokes and strong ink outlines. Characters are dramatic, larger-than-life, and bursting with personality. Dynamic cinematic compositions with expressive poses and exaggerated reactions. The painterly style has visible confident brushwork, vibrant shadows, and punchy highlights. CRITICAL: Do NOT include the MAD magazine logo or title text anywhere in the image. No "MAD" lettering, no magazine masthead, no title banner.`,
  moody: `Moody monochrome stylized 3D paper cutout illustration in black, white, and grays. The scene is constructed like a shallow diorama, using distinct, physically separated layers of thick paper that cast realistic drop shadows on one another to create tangible depth. Each paper layer features thick clean outlines with hand-inked crosshatching and scratchy pen texture for shading, maintaining a slightly uneven line quality like traditional ink on paper. Cute-but-unsettling character design as the central cutout: oversized head, huge empty simple eyes, tiny mouth, minimal nose; small body with simplified hands. Cinematic centered framing, quiet tension, utilizing varying shades of flat mid-gray paper stock. Visible tactile paper grain, slightly curled edges, and faint ink smudges on the surfaces. The background is minimal but grounded, with simple interior props crafted as separate paper pieces drawn in the same inked style. Overall vibe: moody, melancholic, eerie, 3D pop-up storybook graphic novel, high contrast, no color.`,
  storybook: `Whimsical storybook hand-drawn ink style. Hand-drawn black ink outlines with visible rough sketch construction lines, slightly uneven strokes, and occasional line overlap (imperfect but intentional). Bold vivid natural color palette. Crosshatching and scribbly pen shading for depth and texture, especially in shadows and on fabric folds. Watercolor + gouache-like washes: layered, semi-opaque paint with soft gradients. Edges slightly loose (not crisp), with gentle paint bleed and dry-brush texture in places. Cartoon-proportioned character design: slightly exaggerated features (large eyes, long limbs, expressive faces), but grounded in believable anatomy and posture. Background detailed but painterly: textured walls, props with sketchy detail, and atmospheric depth. Subtle grain + ink flecks for a handmade print feel. Cinematic framing, shallow depth cues, soft focus in far background. Editorial illustration / indie animation concept art aesthetic. Charming, cozy, slightly messy, richly textured, high detail, UHD. No 3D render, no clean vector, no flat icon style, no anime/manga linework, no glossy neon gradients, no photorealism.`,
  crayon: `Cute childlike crayon illustration on clean white paper background. Waxy crayon / oil pastel scribble texture with visible stroke marks and uneven fill (messy on purpose). Simple rounded shapes, thick hand-drawn outlines, minimal details, playful proportions (big head, small body). Bright limited palette like orange + blue + yellow, rough shading and light smudges like real crayons on paper. Simple cheerful scene, lots of white space, friendly smiley faces. Looks like kindergarten drawing scanned into computer. High resolution. No vector, no clean digital painting, no 3D, no realism, no gradients, no sharp edges.`,
  chalkboard: `A hand-drawn chalkboard illustration style characterized by voluntarily imperfect, organic lines that capture the authentic vibe of human handwriting. Unlike rigid digital art, the strokes feature subtle wobbles, varying pressure, and natural endpoints, mimicking the tactile feel of chalk held by a steady hand. The background is a deep, dark slate grey, almost black, with a very subtle, fine-grain slate texture that suggests a fresh, clean surface rather than a dusty one. The line work features crisp, monoline chalk outlines that possess the dry, slightly grainy texture of real chalk and are drawn with authentic vibe of hand-drawing, yet ensuring a confident and legible look. The color palette utilizes high-contrast stark white. The rendering is flat and illustrative, with solid chalk fills textured via diagonal hatching or stippling to let the dark background show through slightly, creating a vibe that is smart, academic, and hand-crafted yet thoroughly professional. No other colors than white.`,
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

// ──────────────────── Helper Functions ─────────────────────────────

/** Resolve a style key to the full visual-prompt string. */
export function getStylePrompt(style: string, customStyle?: string): string {
  if (style === "custom" && customStyle) return customStyle;
  return STYLE_PROMPTS[style.toLowerCase()] || style;
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

    // Remove any trailing partial key-value pair (e.g., truncated mid-string)
    fixedContent = fixedContent.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "");
    // Also remove trailing comma after cleanup
    fixedContent = fixedContent.replace(/,\s*$/, "");

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
        console.error(
          `[JSON_EXTRACT] ${label}: all parse attempts failed.`,
          `\nFirst error: ${(firstError as Error).message}`,
          `\nSecond error: ${(secondError as Error).message}`,
          `\nThird error: ${(thirdError as Error).message}`,
          `\nRaw content (first 800 chars): ${raw.substring(0, 800)}`,
          `\nRaw content (last 300 chars): ${raw.substring(Math.max(0, raw.length - 300))}`,
        );
        throw new Error(`Failed to parse ${label}: invalid JSON from LLM`);
      }
    }
  }
}
