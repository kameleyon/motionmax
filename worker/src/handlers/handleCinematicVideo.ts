/**
 * Cinematic video handler — Grok Video I2V via Hypereal.
 *
 * Flow:
 *   - All images are generated FIRST (in parallel batches by the frontend)
 *   - Videos are generated using Grok Video I2V:
 *     image = Scene N's image (first frame)
 *   - No last_image / morph — each scene is self-contained
 *   - Camera motion varies per scene (rotated from 7 movement types)
 *   - Duration: 10s, Resolution: 1080P, No audio
 *
 * Model: grok-video-i2v (12 credits)
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateImage } from "../services/imageGenerator.js";
import { generateGrokVideo } from "../services/hypereal.js";

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

  // Fetch project data
  const { data: project } = await supabase
    .from("projects")
    .select("format, style, character_description, voice_inclination")
    .eq("id", projectId)
    .single();

  const format = project?.format || "landscape";
  const style = project?.style || "realistic";
  const characterDescription = project?.character_description || "";
  const language = project?.voice_inclination || "en";
  const aspectRatio: "16:9" | "9:16" = format === "portrait" ? "9:16" : "16:9";

  // ── Get this scene's image ───────────────────────────────────────
  let imageUrl = scene.imageUrl;
  if (!imageUrl) {
    console.log(`[CinematicVideo] Scene ${sceneIndex}: no image, generating fallback`);
    const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
    const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
    const prompt = scene.visualPrompt || scene.visual_prompt || "Cinematic scene";
    imageUrl = await generateImage(prompt, hyperealApiKey, replicateApiKey, format, projectId);
    await updateSceneField(generationId, sceneIndex, "imageUrl", imageUrl);
  }

  const sourceImageUrl = imageUrl;

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
  const videoPrompt = buildVideoPrompt(visualPrompt, voiceover, characterDescription, style, language, cameraMotion);

  const apiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  if (!apiKey) throw new Error("HYPEREAL_API_KEY not configured");

  console.log(
    `[CinematicVideo] Scene ${sceneIndex}: Grok I2V 10s, ` +
    `camera=${CAMERA_MOTIONS[sceneIndex % CAMERA_MOTIONS.length].split("—")[0].trim()}, ` +
    `prompt=${videoPrompt.length} chars`
  );

  // ── Generate video with Grok Video I2V ───────────────────────────
  const grokVideoUrl = await generateGrokVideo(
    imageUrl,
    videoPrompt,
    apiKey,
    aspectRatio,
    10,       // duration: 10s
    "1080P",  // resolution
  );

  // Upload to Supabase storage
  const finalVideoUrl = await uploadVideoToStorage(grokVideoUrl, projectId, generationId, sceneIndex);

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
    message: `Cinematic video completed for scene ${sceneIndex} (Grok I2V, 10s)`,
  });

  return { success: true, status: "complete", videoUrl: finalVideoUrl, sceneIndex, provider: "Grok I2V" };
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

  parts.push(`STYLE: ${styleName.toUpperCase()}. Maintain this exact visual style throughout.`);

  if (characterDescription) {
    parts.push(`CHARACTER: ${characterDescription.substring(0, 200)}. Same appearance in every frame.`);
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
    `Mix camera motion with character action for maximum dynamism. ` +
    `Continue the movement through the entire shot.`
  );

  parts.push(
    `RULES: No talking, no lip movement, no addressing camera. ` +
    `Expressive faces that match the scene mood — curious, amused, hopeful, surprised, determined. ` +
    `Dynamic body movement at natural speed — never slow motion, never static. ` +
    `Match narration energy. Same character appearance throughout.`
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
