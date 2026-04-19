/**
 * Cinematic video handler — Grok Video I2V (active).
 *
 * Flow:
 *   - All images are generated FIRST (in parallel batches by the frontend)
 *   - ALL scenes use Grok Video I2V (no end_image — Grok doesn't support last_image)
 *   - Camera motion varies per scene (rotated from 7 movement types)
 *
 * Active: grok-video-i2v via Hypereal (1080P, 10s)
 *
 * Previous models (commented out): Kling V2.5 Turbo, PixVerse V6
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateImage } from "../services/imageGenerator.js";
import {
  // generatePixVerseTransition,  // PixVerse V6 — disabled, returns 500 E1001
  // generateKlingV25Video,       // Kling V2.5 Turbo — commented out, switching to Grok
  // generateKlingV3Video,        // V3.0 — faster + cheaper but lip sync issues
  // generateVeo31Video,          // Veo 3.1 — doesn't follow prompts, generates unwanted audio/lip sync
  // generateKlingV26Video,       // Previous fallback — kept for rollback
  generateGrokVideo,              // Active model — Grok Video I2V (no end_image support)
} from "../services/hypereal.js";

// ── Types ──────────────────────────────────────────────────────────

interface CinematicVideoPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  regenerate?: boolean;
}

// ── Camera Motions (rotated per scene) ─────────────────────────────

const CAMERA_MOTIONS = [
  "Pan — camera pivots horizontally left to right, following the subject smoothly. End with a whip pan for energy.",
  "Tilt — camera pivots vertically upward, making the subject appear powerful and grandiose.",
  "Roll — camera rotates on the Z-axis, creating kinetic tension and a sense of unease.",
  "Truck — camera tracks physically to the right, gliding alongside the moving subject.",
  "Pedestal — camera rises vertically while keeping its angle level, revealing the scene from above.",
  "Handheld — camera held naturally with subtle shake for raw, immersive, documentary-like realism.",
  "Rack Focus — lens focus shifts mid-shot from the foreground subject to a background element.",
];

function getCameraMotion(sceneIndex: number): string {
  return CAMERA_MOTIONS[sceneIndex % CAMERA_MOTIONS.length];
}

// ── Main handler ───────────────────────────────────────────────────

export async function handleCinematicVideo(
  jobId: string,
  payload: CinematicVideoPayload,
  userId?: string,
) {
  const { generationId, projectId, sceneIndex, regenerate } = payload;

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_video_started",
    message: `Cinematic video started for scene ${sceneIndex}`,
  });

  // Fetch generation scenes
  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("scenes")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) {
    throw new Error(`Generation not found: ${genError?.message}`);
  }

  const scenes = generation.scenes as any[];
  const scene = scenes[sceneIndex];
  if (!scene) throw new Error(`Scene ${sceneIndex} not found`);

  const totalScenes = scenes.length;
  const isLastScene = sceneIndex === totalScenes - 1;

  // Fetch project data
  const { data: project } = await supabase
    .from("projects")
    .select("format, style, character_description, voice_inclination")
    .eq("id", projectId)
    .single();

  const format = project?.format || "landscape";
  const styleId = project?.style || "realistic";
  const { getStylePrompt: getStyle } = await import("../services/prompts.js");
  const styleDesc = getStyle(styleId);
  const userCharacterDesc = project?.character_description || "";

  // Extract the AI-generated character bible from scene _meta (set during script generation)
  const characterBible: Record<string, string> = scene._meta?.characterBible || {};
  // Build full character description: user's input + AI character bible
  const bibleSummary = Object.entries(characterBible)
    .map(([name, desc]) => `${name}: ${desc}`)
    .join("\n");
  const characterDescription = bibleSummary
    ? `${userCharacterDesc}\n\n--- CHARACTER BIBLE (MUST FOLLOW EXACTLY) ---\n${bibleSummary}`
    : userCharacterDesc;
  const language = project?.voice_inclination || "en";

  // ── Get this scene's image ───────────────────────────────────────
  let imageUrl = scene.imageUrl;
  if (!imageUrl) {
    console.log(`[CinematicVideo] Scene ${sceneIndex}: no image, generating fallback`);
    const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
    const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
    let prompt = scene.visualPrompt || scene.visual_prompt || "Cinematic scene";
    // Inject character bible into image prompt for consistency
    if (bibleSummary) {
      prompt = `${prompt}\n\nCHARACTER APPEARANCE (follow exactly): ${bibleSummary.substring(0, 400)}`;
    }
    imageUrl = await generateImage(prompt, hyperealApiKey, replicateApiKey, format, projectId);
    await updateSceneField(generationId, sceneIndex, "imageUrl", imageUrl);
  }

  const sourceImageUrl = imageUrl;

  // ── Get next scene's image (for end_image transition) ────────────
  let endImageUrl: string | undefined;
  if (!isLastScene) {
    endImageUrl = scenes[sceneIndex + 1]?.imageUrl;

    if (!endImageUrl) {
      // Next scene's image is missing — wait for it with gentle polling
      console.log(`[CinematicVideo] Scene ${sceneIndex}: waiting for scene ${sceneIndex + 1} image...`);
      const MAX_WAIT_MS = 5 * 60 * 1000; // 5 min max wait
      const POLL_INTERVAL_MS = 30_000;     // 30s between polls to avoid rate limits
      const waitStart = Date.now();

      while (!endImageUrl && Date.now() - waitStart < MAX_WAIT_MS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        const { data: freshGen } = await supabase
          .from("generations")
          .select("scenes")
          .eq("id", generationId)
          .maybeSingle();

        const freshScenes = (freshGen?.scenes as any[]) ?? [];
        endImageUrl = freshScenes[sceneIndex + 1]?.imageUrl;

        if (endImageUrl) {
          console.log(`[CinematicVideo] Scene ${sceneIndex}: next scene image now available`);
        }
      }

      if (!endImageUrl) {
        // Still missing after max wait — try generating it ourselves
        console.warn(`[CinematicVideo] Scene ${sceneIndex}: next scene image still missing after ${MAX_WAIT_MS / 1000}s, generating it`);
        const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
        const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
        const nextScene = scenes[sceneIndex + 1];
        const nextPrompt = nextScene?.visualPrompt || nextScene?.visual_prompt || "Cinematic scene";
        try {
          endImageUrl = await generateImage(nextPrompt, hyperealApiKey, replicateApiKey, format, projectId);
          await updateSceneField(generationId, sceneIndex + 1, "imageUrl", endImageUrl);
          console.log(`[CinematicVideo] Scene ${sceneIndex}: generated next scene image as fallback`);
        } catch (imgErr) {
          console.error(`[CinematicVideo] Scene ${sceneIndex}: failed to generate next scene image, proceeding without end_image`);
          endImageUrl = undefined;
        }
      }
    }
  }

  // Snapshot history for undo
  if (regenerate) {
    const history = Array.isArray(scene._history) ? [...scene._history] : [];
    history.push({ timestamp: new Date().toISOString(), videoUrl: scene.videoUrl });
    if (history.length > 5) history.shift();
    scenes[sceneIndex]._history = history;
    await supabase.from("generations").update({ scenes }).eq("id", generationId);
  }

  // ── Build prompt with camera motion ──────────────────────────────
  const visualPrompt = scene.visualPrompt || scene.visual_prompt || "";
  const voiceover = scene.voiceover || "";
  const cameraMotion = getCameraMotion(sceneIndex);
  const videoPrompt = buildVideoPrompt(visualPrompt, voiceover, characterDescription, styleDesc, language, cameraMotion);

  const apiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  if (!apiKey) throw new Error("HYPEREAL_API_KEY not configured");

  // Add scene-specific instructions based on transition type
  let sceneInstruction = "";
  if (endImageUrl) {
    // Scenes WITH transition to next scene
    sceneInstruction =
      `\n\nTRANSITION RULES (CRITICAL):` +
      `\n- For the first 9 seconds: focus ENTIRELY on the current scene's action matching the voiceover.` +
      `\n- ONLY in the LAST 1 second: begin a NATURAL transition to the next scene.` +
      `\n- The transition MUST be a natural camera movement (pan away, fade to new setting, walk through doorway, turn a corner).` +
      `\n- NEVER morph a person's body into another person or object. NO body contortions, NO limbs stretching, NO faces melting into other faces.` +
      `\n- NEVER make characters fly, levitate, or defy physics unless the story explicitly calls for it.` +
      `\n- Characters must maintain physical integrity — heads face forward, bodies stay proportioned.` +
      `\n- Think FILM CUT, not shapeshifting. The camera moves AWAY from the current scene and TOWARD the next.`;
  } else {
    // LAST scene — no transition, must end naturally
    sceneInstruction =
      `\n\nFINAL SCENE RULES (CRITICAL):` +
      `\n- This is the LAST scene. There is NO next scene to transition to.` +
      `\n- Generate FORWARD-MOVING action that reaches a natural conclusion by the end of the 10 seconds.` +
      `\n- Do NOT create a looping animation. Do NOT have the camera or subject return to its starting position.` +
      `\n- End with a DECISIVE moment: character walks away into distance, camera pulls back to wide shot, fade to a closing frame.` +
      `\n- The motion should SLOW DOWN naturally in the last 1 second, coming to a satisfying visual rest.`;
  }
  const finalPrompt = videoPrompt + sceneInstruction;

  const cameraName = CAMERA_MOTIONS[sceneIndex % CAMERA_MOTIONS.length].split("\u2014")[0].trim();
  console.log(
    `[CinematicVideo] Scene ${sceneIndex}: Grok Video I2V, ` +
    `camera=${cameraName}, prompt=${finalPrompt.length} chars`
  );

  // ── Generate video ────────────────────────────────────────────────
  let videoUrl: string;
  let provider: string;
  const negPrompt = "blurry, low quality, watermark, text, UI elements, slow motion, sluggish, nudity, naked, exposed body, extra limbs, body contortion, distorted anatomy, lip sync, talking, mouth movement, speaking";

  // ── Grok Video I2V (active) — no end_image support ──────────────
  const aspectRatio = format === "portrait" ? "9:16" as const : "16:9" as const;
  provider = "Grok Video I2V";
  videoUrl = await generateGrokVideo(imageUrl, finalPrompt, apiKey, aspectRatio, 10, "1080P");

  // ── Kling V2.5 Turbo (commented out — previous model) ─────────
  // if (endImageUrl) {
  //   provider = "Kling V2.5 Turbo I2V";
  //   videoUrl = await generateKlingV25Video(imageUrl, finalPrompt, apiKey, 10, endImageUrl, negPrompt, 0.8);
  // } else {
  //   provider = "Kling V2.5 Turbo I2V";
  //   videoUrl = await generateKlingV25Video(imageUrl, finalPrompt, apiKey, 10, undefined, negPrompt, 0.8);
  // }

  // Upload to Supabase storage
  const finalVideoUrl = await uploadVideoToStorage(videoUrl, projectId, generationId, sceneIndex);

  // Stale-image guard (for scene 0)
  if (sceneIndex === 0) {
    const { data: freshGen } = await supabase
      .from("generations").select("scenes").eq("id", generationId).maybeSingle();
    const freshImageUrl = ((freshGen?.scenes as any[]) ?? [])[sceneIndex]?.imageUrl;
    if (freshImageUrl && freshImageUrl !== sourceImageUrl) {
      console.warn(`[CinematicVideo] Scene ${sceneIndex}: image changed — discarding stale video`);
      return { success: true, status: "stale_discarded", videoUrl: null, sceneIndex };
    }
  }

  await updateSceneField(generationId, sceneIndex, "videoUrl", finalVideoUrl);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_video_completed",
    message: `Cinematic video completed for scene ${sceneIndex} (${provider}, 10s${endImageUrl ? ", with transition" : ""})`,
    details: { provider, hasTransition: !!endImageUrl, cost: 0.40 },
  });

  return {
    success: true,
    status: "complete",
    videoUrl: finalVideoUrl,
    sceneIndex,
    provider,
    hasTransition: !!endImageUrl,
    cost: 0.40,
  };
}

// ── Prompt builder with camera motion ──────────────────────────────

function buildVideoPrompt(
  visualPrompt: string,
  voiceover: string,
  characterDescription: string,
  styleName: string,
  language: string,
  cameraMotion: string,
): string {
  const MAX_CHARS = 2400;
  const parts: string[] = [];

  parts.push(`VISUAL STYLE (MANDATORY): ${styleName}. Maintain this exact visual style in every frame. Do NOT switch to photorealistic if the style is caricature. Do NOT switch to cartoon if the style is realistic.`);

  if (characterDescription) {
    // Give the character bible more space — this is critical for consistency
    parts.push(`CHARACTER CONSISTENCY (MANDATORY — FOLLOW EXACTLY):\n${characterDescription.substring(0, 600)}\nEvery character MUST look IDENTICAL to this description in every frame — same hair, same clothes, same skin tone, same build. NO variations.`);
  }

  parts.push(visualPrompt.substring(0, 500));

  if (voiceover) {
    parts.push(`CONTEXT: ${voiceover.substring(0, 200)}`);
  }

  if (language && language !== "en") {
    const langName = language === "fr" ? "French" : language === "ht" ? "Haitian Creole" : language;
    parts.push(`Any visible text must be in ${langName}.`);
  }

  parts.push(
    `CAMERA MOVEMENT: ${cameraMotion} ` +
    `Camera motion must be CONFIDENT, FAST, and ENERGETIC — not lazy or drifting. ` +
    `Continue the movement through the entire shot with URGENCY and PURPOSE.`
  );

  parts.push(
    `PACING: FAST-PACED action throughout the entire 10 seconds. ` +
    `Characters move QUICKLY and DECISIVELY — walking briskly, gesturing sharply, reacting instantly. ` +
    `Camera moves with SPEED and CONFIDENCE. Every second is packed with motion and energy. ` +
    `Think action movie or viral TikTok energy — NEVER slow, NEVER sluggish, NEVER drifting.`
  );

  parts.push(
    `RULES: No talking, no lip movement, no addressing camera. ` +
    `Expressive faces that match the scene mood — curious, amused, hopeful, surprised, determined. ` +
    `CRITICAL: Character must have the EXACT SAME hair style, hair color, clothing, skin tone, and body type as described in the CHARACTER section above. ` +
    `If they wear a blue jacket in the description, they wear a blue jacket here. No exceptions. ` +
    `NO nudity, NO exposed body parts, NO weird body transformations or contortions. ` +
    `All characters fully clothed with correct anatomy — no extra limbs, no distorted proportions.`
  );

  let prompt = parts.join("\n\n");
  if (prompt.length > MAX_CHARS) {
    prompt = prompt.substring(0, MAX_CHARS - 3) + "...";
  }
  return prompt;
}

// ── Storage upload ─────────────────────────────────────────────────

async function uploadVideoToStorage(
  videoUrl: string,
  projectId: string,
  generationId: string,
  sceneIndex: number,
): Promise<string> {
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Failed to download video: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const fileName = `${projectId}/${generationId}/scene_${sceneIndex}_${Date.now()}.mp4`;

  const { error } = await supabase.storage
    .from("scene-videos")
    .upload(fileName, buffer, { contentType: "video/mp4", upsert: true });
  if (error) throw new Error(`Upload failed: ${error.message}`);

  const { data } = supabase.storage.from("scene-videos").getPublicUrl(fileName);
  return data.publicUrl;
}
