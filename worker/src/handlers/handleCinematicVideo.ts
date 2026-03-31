/**
 * Cinematic video handler — LTX 2.3 Pro with first + last frame interpolation.
 *
 * Flow:
 *   - All images are generated FIRST (in parallel batches by the frontend)
 *   - Videos are generated using Replicate LTX 2.3 Pro:
 *     image = Scene N's image (first frame)
 *     last_frame_image = Scene N+1's image (morph target)
 *   - Last scene: no last_frame_image (just scene motion)
 *   - Camera motion is varied per scene from the LTX enum
 *
 * The frontend dispatches video jobs for scenes whose images (and next scene's image)
 * are already available. This handler does NOT wait for images — they should already exist.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateImage } from "../services/imageGenerator.js";
import { generateVeoVideo } from "../services/ltxVideo.js";
import { getStylePrompt } from "../services/prompts.js";

// ── Types ──────────────────────────────────────────────────────────

interface CinematicVideoPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  regenerate?: boolean;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Wait for a specific scene's imageUrl to appear in the DB.
 * Used when the video job is dispatched before the image batch finishes.
 */
async function waitForSceneImage(
  generationId: string,
  sceneIndex: number,
  maxWaitMs: number = 10 * 60 * 1000 // 10 min — images can take 3 min each, batch of 4 = up to 6-8 min
): Promise<string | null> {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < maxWaitMs) {
    const { data: gen } = await supabase
      .from("generations")
      .select("scenes")
      .eq("id", generationId)
      .maybeSingle();
    const url = ((gen?.scenes as any[]) ?? [])[sceneIndex]?.imageUrl;
    if (url) {
      console.log(`[CinematicVideo] Scene ${sceneIndex} image found after ${Math.round((Date.now() - start) / 1000)}s`);
      return url;
    }
    attempts++;
    if (attempts % 6 === 0) {
      console.log(`[CinematicVideo] Still waiting for scene ${sceneIndex} image... (${Math.round((Date.now() - start) / 1000)}s)`);
    }
    await sleep(5_000);
  }
  console.warn(`[CinematicVideo] Scene ${sceneIndex} image not found after ${maxWaitMs / 1000}s`);
  return null;
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
    .select("format, style, character_description, presenter_focus, voice_inclination")
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
    console.log(`[CinematicVideo] Scene ${sceneIndex}: waiting for image...`);
    imageUrl = await waitForSceneImage(generationId, sceneIndex);
  }
  if (!imageUrl) {
    // Last resort: generate it
    console.log(`[CinematicVideo] Scene ${sceneIndex}: generating image as fallback`);
    const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
    const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
    const prompt = scene.visualPrompt || scene.visual_prompt || "Cinematic scene";
    imageUrl = await generateImage(prompt, hyperealApiKey, replicateApiKey, format, projectId);
    await updateSceneField(generationId, sceneIndex, "imageUrl", imageUrl);
  }

  const sourceImageUrl = imageUrl;

  // ── Get next scene's image for last_frame_image ──────────────────
  const isLastScene = sceneIndex >= scenes.length - 1;
  let nextImageUrl: string | null = null;

  if (!isLastScene) {
    nextImageUrl = scenes[sceneIndex + 1]?.imageUrl || null;
    if (!nextImageUrl) {
      console.log(`[CinematicVideo] Scene ${sceneIndex}: waiting for scene ${sceneIndex + 1} image...`);
      nextImageUrl = await waitForSceneImage(generationId, sceneIndex + 1);
    }
    if (nextImageUrl) {
      console.log(`[CinematicVideo] Scene ${sceneIndex}: will morph → scene ${sceneIndex + 1}`);
    } else {
      console.log(`[CinematicVideo] Scene ${sceneIndex}: next image not available, no morph`);
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

  // ── Build prompt ─────────────────────────────────────────────────
  const visualPrompt = scene.visualPrompt || scene.visual_prompt || "";
  const voiceover = scene.voiceover || "";
  const videoPrompt = buildVideoPrompt(visualPrompt, voiceover, characterDescription, style, language);

  console.log(
    `[CinematicVideo] Scene ${sceneIndex}: Veo 3.1 8s, ` +
    `morph=${!!nextImageUrl}, prompt=${videoPrompt.length} chars`
  );

  // ── Generate video with Veo 3.1 Fast I2V ──────────────────────────
  const result = await generateVeoVideo({
    prompt: videoPrompt,
    imageUrl,
    lastImageUrl: nextImageUrl || undefined,
    aspectRatio,
  });

  if (!result.url) {
    throw new Error(`Video generation failed for scene ${sceneIndex}: ${result.error}`);
  }

  // Upload to Supabase storage
  const finalVideoUrl = await uploadVideoToStorage(result.url, projectId, generationId, sceneIndex);

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
    message: `Cinematic video completed for scene ${sceneIndex} (Veo 3.1, 8s)`,
  });

  return { success: true, status: "complete", videoUrl: finalVideoUrl, sceneIndex, provider: "Veo 3.1" };
}

// ── Prompt builder (stays under 2500 chars) ────────────────────────

function buildVideoPrompt(
  visualPrompt: string,
  voiceover: string,
  characterDescription: string,
  styleName: string,
  language: string,
): string {
  const MAX_CHARS = 2400;
  const parts: string[] = [];

  parts.push(`STYLE: ${styleName.toUpperCase()}. Maintain this exact visual style. Do not mix styles.`);

  if (characterDescription) {
    parts.push(`CHARACTER: ${characterDescription.substring(0, 200)}. Keep EXACT same appearance throughout.`);
  }

  parts.push(visualPrompt.substring(0, 600));

  if (voiceover) {
    parts.push(`CONTEXT: ${voiceover.substring(0, 250)}`);
  }

  if (language && language !== "en") {
    const langName = language === "fr" ? "French" : language === "ht" ? "Haitian Creole" : language;
    parts.push(`Any visible text must be in ${langName}.`);
  }

  parts.push(
    `RULES: No talking, no lip movement, no addressing camera. ` +
    `Rich facial expressions (shock, joy, fear, anger). ` +
    `Dynamic body movement at natural speed. Never static. ` +
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
