import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { decode as base64Decode, encode as base64Encode } from "https://deno.land/std@0.190.0/encoding/base64.ts";
import {
  generateSceneAudio as sharedGenerateSceneAudio,
  isHaitianCreole,
  pcmToWav,
  type AudioEngineConfig,
  type StorageStrategy,
} from "../_shared/audioEngine.ts";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";

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
  regenerate?: boolean;
}

interface Scene {
  number: number;
  voiceover: string;
  visualPrompt: string;
  visual_prompt?: string;  // Legacy alias for backward compatibility
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

  realistic: `Photorealistic cinematic photography. 4K UHD, HDR, 8k resolution. Shot on 35mm lens with shallow depth of field (bokeh) to isolate subjects. Hyper-realistic textures, dramatic studio lighting with rim lights. Natural skin tones and accurate material physics. Look of high-end stock photography or a Netflix documentary. Sharp focus, rich contrast, and true-to-life color grading. Unreal Engine 5 render quality, like shot on Kodak Gold 400 film tones.`,

  anime: `Expressive Modern Manga-Style Sketchbook. An expressive modern manga-style sketchbook illustration. Anatomy: Large-eye expressive anime/manga influence focusing on high emotional impact and kawaii but relatable proportions. Line Work: Very loose, visible rough sketch lines—looks like a final drawing made over a messy pencil draft. Coloring: Natural tones with focus on skin-glow, painterly approach with visible thick brush strokes. Vibe: Cozy, chaotic, and sentimental slice-of-life moments. Features loose sketchy digital pencil lines and painterly slice-of-life aesthetic. High-detail facial expressions with large emotive eyes. Visible brush strokes. Set in detailed, slightly messy environment that feels lived-in. Cozy, relatable, and artistically sophisticated.`,

  "3D Pix": `Cinematic 3D Animation. A stunning 3D cinematic animation-style render in the aesthetic of modern Disney-Pixar films. Surface Geometry: Squash and Stretch—appealing rounded shapes with soft exaggerated features, avoiding sharp angles unless part of mechanical design. Material Science: Subsurface Scattering—that Disney glow where light slightly penetrates the surface like real skin or wax, textures are stylized realism with soft fur, knit fabrics, or polished plastic. Lighting Design: Three-Point Cinematic—strong key light, soft fill light to eliminate harsh shadows, bright rim light (backlight) creating glowing silhouette separating from background. Eyes: The Soul Focal Point—large, highly detailed eyes with realistic specular highlights and deep iris colors making character feel sentient and emotive. Atmosphere: Volumetric Depth—light fog, dust motes, or god rays creating sense of physical space, background has soft bokeh blur keeping focus on subject. High-detail textures, expressive large eyes, soft rounded features. Vibrant saturated colors with high-end subsurface scattering on all surfaces. Rendered in 8k using Octane, shallow depth of field, whimsical softly blurred background. Masterpiece quality, charming, tactile, and highly emotive, like shot on Kodak Gold 400 film tones.`,

  claymation: `Handcrafted Digital Clay. A high-detail 3D claymation-style render. Material Texture: Matte & Tactile—surfaces must show subtle, realistic imperfections like tiny thumbprints, slight molding creases, and a soft matte finish that mimics polymer clay (like Sculpey or Fimo). Lighting: Miniature Macro Lighting—soft, high-contrast studio lighting that makes the subject look like a small physical object, includes Rim Lighting to make the edges glow and deep, soft-edge shadows. Proportions: Chunky & Appealing—thick, rounded limbs and exaggerated squashy features, avoid any sharp digital edges, everything should look like it was rolled between two palms. Atmosphere: Depth of Field—heavy background blur (bokeh) essential to sell the small toy scale, making the subject pop as the central focus. Color Palette: Saturated & Playful—bold, solid primary colors that look like they came straight out of a clay pack, avoiding complex gradients. 8k resolution, Octane Render, masterpiece quality.`,

  sketch: `Emphasize the paper cutout effect with a strong dark 3D backdrop shadow. Hand-drawn stick figure comic style, but with a polished, clean digital finish. Smooth, expressive black marker lines on pure white. Extremely simple character designs (perfect single-stroke circles for heads, solid single lines for limbs). Avoid sketchy, wobbly, or overlapping rough lines; use confident, clean monoline strokes instead. Strictly black and white line art. High contrast black and white ONLY, no other color. Focus on humor and clarity while maintaining a neat professional aesthetic. Crucial Effect: Apply strong "paper cutout" 3D drop shadows behind the characters and objects to make them pop off the page like a diorama. Ensure natural orientation and correct anatomy (two arms, two legs). Make it detailed, highly creative, extremely expressive, and dynamic, while keeping character consistency. Include environment or setting of the scene so the user can see where the scene is happening. Make on a plain solid white background. ANIMATION RULES (CRITICAL): NO lip-sync talking animation - characters should NOT move their mouths as if speaking. Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry. Body movement IS allowed: walking, running, gesturing, pointing, reacting. Environment animation IS allowed: wind, particles, camera movement, lighting changes. Static poses with subtle breathing/idle movement are preferred for dialogue scenes. Focus on CAMERA MOTION and SCENE DYNAMICS rather than character lip movement.`,

  caricature: `Humorous caricature illustration inspired by the visual aesthetic of MAD Magazine cover art — bold, dynamic, richly painted with energetic brushwork. Highly exaggerated facial features: oversized heads, giant expressive eyes, huge noses, rubbery lips, tiny bodies. Vivid, saturated color palette with loose oil-painting brushstrokes and strong ink outlines. Characters are dramatic, larger-than-life, and bursting with personality. Dynamic cinematic compositions with expressive poses and exaggerated reactions. The painterly style has visible confident brushwork, vibrant shadows, and punchy highlights. CRITICAL: Do NOT include the MAD magazine logo or title text anywhere in the image. No "MAD" lettering, no magazine masthead, no title banner.`,

  moody: `Moody monochrome stylized 3D paper cutout illustration in black, white, and grays. The scene is constructed like a shallow diorama, using distinct, physically separated layers of thick paper that cast realistic drop shadows on one another to create tangible depth. Each paper layer features thick clean outlines with hand-inked crosshatching and scratchy pen texture for shading, maintaining a slightly uneven line quality like traditional ink on paper. Cute-but-unsettling character design as the central cutout: oversized head, huge empty simple eyes, tiny mouth, minimal nose; small body with simplified hands. Cinematic centered framing, quiet tension, utilizing varying shades of flat mid-gray paper stock. Visible tactile paper grain, slightly curled edges, and faint ink smudges on the surfaces. The background is minimal but grounded, with simple interior props crafted as separate paper pieces drawn in the same inked style. Overall vibe: moody, melancholic, eerie, 3D pop-up storybook graphic novel, high contrast, no color.`,

  storybook: `Whimsical storybook hand-drawn ink style. Hand-drawn black ink outlines with visible rough sketch construction lines, slightly uneven strokes, and occasional line overlap (imperfect but intentional). Bold vivid natural color palette. Crosshatching and scribbly pen shading for depth and texture, especially in shadows and on fabric folds. Watercolor + gouache-like washes: layered, semi-opaque paint with soft gradients. Edges slightly loose (not crisp), with gentle paint bleed and dry-brush texture in places. Cartoon-proportioned character design: slightly exaggerated features (large eyes, long limbs, expressive faces), but grounded in believable anatomy and posture. Background detailed but painterly: textured walls, props with sketchy detail, and atmospheric depth. Subtle grain + ink flecks for a handmade print feel. Cinematic framing, shallow depth cues, soft focus in far background. Editorial illustration / indie animation concept art aesthetic. Charming, cozy, slightly messy, richly textured, high detail, UHD. No 3D render, no clean vector, no flat icon style, no anime/manga linework, no glossy neon gradients, no photorealism.`,

  crayon: `Cute childlike crayon illustration on clean white paper background. Waxy crayon / oil pastel scribble texture with visible stroke marks and uneven fill (messy on purpose). Simple rounded shapes, thick hand-drawn outlines, minimal details, playful proportions (big head, small body). Bright limited palette like orange + blue + yellow, rough shading and light smudges like real crayons on paper. Simple cheerful scene, lots of white space, friendly smiley faces. Looks like kindergarten drawing scanned into computer. High resolution. No vector, no clean digital painting, no 3D, no realism, no gradients, no sharp edges.`,

  chalkboard: `A hand-drawn chalkboard illustration style characterized by voluntarily imperfect, organic lines that capture the authentic vibe of human handwriting. Unlike rigid digital art, the strokes feature subtle wobbles, varying pressure, and natural endpoints, mimicking the tactile feel of chalk held by a steady hand. The background is a deep, dark slate grey, almost black, with a very subtle, fine-grain slate texture that suggests a fresh, clean surface rather than a dusty one. The line work features crisp, monoline chalk outlines that possess the dry, slightly grainy texture of real chalk and are drawn with authentic vibe of hand-drawing, yet ensuring a confident and legible look. The color palette utilizes high-contrast stark white. The rendering is flat and illustrative, with solid chalk fills textured via diagonal hatching or stippling to let the dark background show through slightly, creating a vibe that is smart, academic, and hand-crafted yet thoroughly professional. No other colors than white.`,

  babie: `Highly expressive Barbie-style extremely close-up portrait, glamorous fashion doll with exaggerated annoyed / disgusted expression, scrunched nose, curled upper lip, asymmetrical pout, narrowed half-lidded eyes, deeply unimpressed "are you serious?" face, smooth glossy plastic skin, sharp makeup, dramatic lashes, sleek rooted messy disheveled hair with flyaway chaos, cinematic toy, extreme close-up, shallow depth of field, crisp facial definition, high-detail plastic texture, soft but clear lighting, luxury Barbie realism, attitude, annoyed bratty elegance, iconic doll face, unhinged enough to feel alive. Ultra High Definition, HDR, with a Kodak Gold 400 film tones`,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// isHaitianCreole and pcmToWav are imported from ../_shared/audioEngine.ts above

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

// Script generation is offloaded to the generate_video worker job
// (worker/src/handlers/generateVideo.ts) to avoid edge-function timeouts on
// the 4-6 minute cold path. The inline generateScriptWithGemini function has
// been removed; the phase === "script" handler now queues a worker job.

// ============================================
// STEP 2: Audio Generation — delegates to Universal Audio Engine
// (_shared/audioEngine.ts) for all TTS routing, key rotation, and batching.
// ============================================

// resolveChatterbox removed — shared engine handles Chatterbox synchronously

// ============================================
// STEP 3: Image Generation with Hypereal gemini-3-1-flash-t2i
// ============================================
const HYPEREAL_API_URL = "https://api.hypereal.cloud/v1/images/generate";

async function generateSceneImage(
  scene: Scene,
  style: string,
  format: "landscape" | "portrait" | "square",
  replicateToken: string,
  supabase: ReturnType<typeof createClient>,
  characterBible: Record<string, string> = {},
  characterDescription: string = "",
): Promise<string> {
  const aspectRatio = format === "portrait" ? "9:16" : format === "square" ? "1:1" : "16:9";

  const styleKey = style.toLowerCase();
  const fullStylePrompt = STYLE_PROMPTS[styleKey] || STYLE_PROMPTS[style] || style;

  // Build character consistency block
  let characterConsistencyBlock = "";
  const hasCharacterBible = Object.keys(characterBible).length > 0;
  if (hasCharacterBible) {
    const entries = Object.entries(characterBible)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n");
    characterConsistencyBlock = `

CHARACTER CONSISTENCY BIBLE (apply EXACTLY for any character in this scene):
${entries}

CRITICAL RULES:
1. Characters MUST match their bible description exactly — do not improvise appearance
2. Match age to temporal context (childhood scene → show as child; adult scene → show as adult)
3. Maintain consistent ethnicity, skin tone, hair, and clothing across all scenes`;
  } else if (characterDescription) {
    characterConsistencyBlock = `

CHARACTER APPEARANCE REQUIREMENTS (maintain across ALL scenes):
${characterDescription}

CONSISTENCY RULES:
1. All characters MUST match the above description — do not invent different appearances
2. Keep skin tone, hair color/style, clothing, and body type consistent throughout`;
  }

  const imagePrompt = `${fullStylePrompt}

SCENE DESCRIPTION: ${scene.visualPrompt}

CAMERA/SHOT STYLE: ${scene.visualStyle}

FORMAT: ${format === "portrait" ? "VERTICAL 9:16 portrait orientation (tall, like a phone screen)" : format === "square" ? "SQUARE 1:1 aspect ratio (equal width and height)" : "HORIZONTAL 16:9 landscape orientation (wide, like a TV screen)"}. The image MUST be composed for this exact aspect ratio.
${characterConsistencyBlock}

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
            resolution: "1K",
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
const HYPEREAL_VIDEO_URL = "https://api.hypereal.cloud/v1/videos/generate";

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
const HYPEREAL_JOB_POLL_URL = "https://api.hypereal.cloud/v1/jobs";

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
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  let parsedGenerationId: string | undefined;

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonResponse({ error: "Not authenticated" }, { status: 401 });

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const replicateToken = Deno.env.get("REPLICATE_API_TOKEN");

    if (!supabaseUrl || !supabaseKey) throw new Error("Backend configuration missing");
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

    // Rate limit
    const rateLimitResult = await checkRateLimit(supabase, {
      key: "generate-cinematic",
      maxRequests: 3,
      windowSeconds: 60,
      userId: user?.id,
    });
    if (!rateLimitResult.allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 429,
      });
    }

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

    let body: CinematicRequest;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON request body" }, { status: 400 });
    }
    parsedGenerationId = body.generationId; // Cache for error handler
    const phase: Phase = body.phase || "script";

    // =============== PHASE 1: SCRIPT (offloaded to worker) ===============
    // Script generation calls a large LLM that can take 4-6 minutes for a full
    // 28-36 scene cinematic. Running inline would timeout the edge function.
    // Instead we deduct credits upfront, enqueue a generate_video worker job,
    // and return the jobId so the caller can poll video_generation_jobs.
    if (phase === "script") {
      const content = requireString(body.content, "content");
      const format = (body.format || "portrait") as "landscape" | "portrait" | "square";
      const length = requireString(body.length, "length");
      const style = requireString(body.style, "style");

      // Upfront credit deduction — mirror src/lib/planLimits.ts getCreditsRequired("cinematic").
      const LENGTH_SECONDS: Record<string, number> = {
        short: 150,
        brief: 280,
        presentation: 360,
      };
      const lengthSeconds = LENGTH_SECONDS[length] ?? LENGTH_SECONDS.brief;
      const CINEMATIC_CREDIT_COST = Math.ceil(lengthSeconds * 5);

      const { data: deductionSuccess, error: rpcError } = await supabase.rpc(
        "deduct_credits_securely",
        {
          p_user_id: user.id,
          p_amount: CINEMATIC_CREDIT_COST,
          p_transaction_type: "usage",
          p_description: `Cinematic generation started (${length}, ${CINEMATIC_CREDIT_COST} credits)`,
        },
      );

      if (rpcError || !deductionSuccess) {
        console.error(`[CINEMATIC] Credit deduction failed for user ${user.id}:`, rpcError?.message);
        return jsonResponse({
          error: `Insufficient credits. Cinematic ${length} generation requires ${CINEMATIC_CREDIT_COST} credits.`,
          code: "INSUFFICIENT_CREDITS",
        }, { status: 402 });
      }
      console.log(`[CINEMATIC] Deducted ${CINEMATIC_CREDIT_COST} credits for user ${user.id} (${length})`);

      // Enqueue script generation as a worker job — worker has no timeout limit.
      const jobPayload = {
        phase: "script",
        projectType: "cinematic",
        content,
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
      };

      const { data: job, error: jobError } = await supabase
        .from("video_generation_jobs")
        .insert({
          user_id: user.id,
          task_type: "generate_video",
          status: "pending",
          payload: jobPayload,
        })
        .select("id")
        .single();

      if (jobError || !job) {
        // Refund credits since we could not queue the job
        await supabase.rpc("refund_credits", {
          p_user_id: user.id,
          p_amount: CINEMATIC_CREDIT_COST,
        }).catch((e: unknown) =>
          console.error("[CINEMATIC] Refund failed after job insert error:", e)
        );
        throw new Error(`Failed to queue cinematic script job: ${jobError?.message}`);
      }

      console.log(`[CINEMATIC] Script job queued: ${job.id}`);
      return jsonResponse({ success: true, pending: true, jobId: job.id });
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
        fishAudioApiKey: Deno.env.get("FISH_AUDIO_API_KEY"),
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

      // We need style + format + character data from the project record
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, style, format, character_description")
        .eq("id", generation.project_id)
        .maybeSingle();

      if (projectError || !project) throw new Error("Project not found");

      // Read character bible stored on scenes[0] during script phase
      const charBible: Record<string, string> = (scenesRaw[0] as any)?._characterBible || {};

      const imageUrl = await generateSceneImage(
        scene,
        project.style || "realistic",
        (project.format || "portrait") as "landscape" | "portrait" | "square",
        replicateToken,
        supabase,
        charBible,
        project.character_description || "",
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
          const predictionId = await startSeedance(scene, scene.imageUrl || "", format, replicateToken);
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
        return jsonResponse({ success: true, status: "processing", retryAfterMs: 5000, scene });
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

      // Apply Edit — PRIMARY: Hypereal gemini-3-1-flash-t2i via generateSceneImage
      // Injects the modification into the visual prompt and generates a new image
      console.log(`[IMG-EDIT] Scene ${scene.number}: Applying edit via Hypereal T2I (modification in prompt)`);
      const sceneWithEdit = {
        ...scene,
        visualPrompt: `${scene.visualPrompt}\n\nUSER MODIFICATION REQUEST: ${modification}`,
      };
      const newImageUrl = await generateSceneImage(sceneWithEdit, style, format, replicateToken, supabase);
      console.log(`[IMG-EDIT] Scene ${scene.number} edited image generated: ${newImageUrl}`);

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

      // Get project for style/format/character data
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("id, style, format, character_description")
        .eq("id", generation.project_id)
        .maybeSingle();
      if (projectError || !project) throw new Error("Project not found");

      const format = (project.format || "portrait") as "landscape" | "portrait" | "square";
      const style = project.style || "realistic";
      const regenCharBible: Record<string, string> = (scenesRaw[0] as any)?._characterBible || {};

      console.log(`[IMG-REGEN] Scene ${scene.number}: Regenerating image`);

      // Generate new image with character consistency
      const newImageUrl = await generateSceneImage(scene, style, format, replicateToken, supabase, regenCharBible, project.character_description || "");

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

      // Set thumbnail_url immediately from first scene's imageUrl (always works, even if re-upload fails)
      const firstSceneWithImage = scenes.find((s) => s.imageUrl);
      const directThumbnail = firstSceneWithImage?.imageUrl || null;

      await supabase.from("projects").update({
        status: "complete",
        ...(directThumbnail ? { thumbnail_url: directThumbnail } : {}),
      }).eq("id", generation.project_id);

      // Try to save a permanent copy in Supabase storage (upgrades the temporary AI URL)
      try {
        if (directThumbnail) {
          const imageResponse = await fetch(directThumbnail);
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
              console.log(`[FINALIZE] Cinematic thumbnail saved permanently: ${publicUrlData.publicUrl}`);
            }
          }
        }
      } catch (thumbErr) {
        console.warn("[FINALIZE] Permanent thumbnail save failed (using direct URL):", thumbErr);
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
