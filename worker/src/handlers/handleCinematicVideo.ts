/**
 * Cinematic video handler — CHAINED SEQUENTIAL GENERATION.
 *
 * Each scene's video starts from where the previous one ended:
 *   Scene 1: generated image → Grok → video 1
 *   Scene 2: last frame of video 1 → Grok → video 2
 *   Scene 3: last frame of video 2 → Grok → video 3
 *   ...
 *
 * This creates natural visual continuity — no separate transitions needed.
 * Videos are concatenated directly during export.
 *
 * Provider: Grok Video I2V (Hypereal primary, Replicate fallback)
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateImage } from "../services/imageGenerator.js";
import { generateGrokVideo, type GrokVideoInput } from "../services/grokVideo.js";
import { getStylePrompt } from "../services/prompts.js";
import { runFfmpeg } from "./export/ffmpegCmd.js";
import fs from "fs";
import path from "path";
import os from "os";

// ── Types ──────────────────────────────────────────────────────────

interface CinematicVideoPayload {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  regenerate?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Wait for the PREVIOUS scene's videoUrl to be available in the DB.
 * The cinematic pipeline dispatches videos in parallel, but each scene
 * needs the previous one's last frame. This polls until it's ready.
 */
async function waitForPreviousSceneVideo(
  generationId: string,
  prevSceneIndex: number,
  maxWaitMs: number = 20 * 60 * 1000 // 20 min max wait (Grok can take 10-15 min)
): Promise<string | null> {
  const startTime = Date.now();
  const pollInterval = 10_000; // check every 10s

  console.log(`[CinematicVideo] Waiting for scene ${prevSceneIndex} video to finish...`);

  while (Date.now() - startTime < maxWaitMs) {
    const { data: gen } = await supabase
      .from("generations")
      .select("scenes")
      .eq("id", generationId)
      .maybeSingle();

    const scenes = (gen?.scenes as any[]) ?? [];
    const prevVideoUrl = scenes[prevSceneIndex]?.videoUrl;

    if (prevVideoUrl) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[CinematicVideo] Scene ${prevSceneIndex} video ready after ${elapsed}s`);
      return prevVideoUrl;
    }

    await sleep(pollInterval);
  }

  console.warn(`[CinematicVideo] Scene ${prevSceneIndex} video not ready after ${maxWaitMs / 1000}s`);
  return null;
}

/**
 * Extract the last frame of a video and upload it to Supabase storage.
 * Returns the public URL of the uploaded frame.
 */
async function extractAndUploadLastFrame(
  videoUrl: string,
  projectId: string,
  sceneIndex: number,
): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `cinematic_frame_${Date.now()}`);
  const videoPath = path.join(tempDir, "prev_video.mp4");
  const framePath = path.join(tempDir, "last_frame.png");

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    // Download the previous video
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(videoPath, buffer);

    // Extract last frame
    await runFfmpeg([
      "-sseof", "-0.1",
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "2",
      framePath,
    ], 30_000);

    // Upload frame to storage
    const frameBuffer = await fs.promises.readFile(framePath);
    const fileName = `chained-frames/${projectId}/scene_${sceneIndex}_input_${Date.now()}.png`;

    const { error } = await supabase.storage
      .from("scene-videos")
      .upload(fileName, frameBuffer, { contentType: "image/png", upsert: true });

    if (error) throw new Error(`Frame upload failed: ${error.message}`);

    const { data } = supabase.storage.from("scene-videos").getPublicUrl(fileName);
    console.log(`[CinematicVideo] Last frame extracted and uploaded for scene ${sceneIndex}`);
    return data.publicUrl;
  } finally {
    // Cleanup temp files
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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

  // ── Fetch project data (style, character, content context, language) ──
  const { data: project } = await supabase
    .from("projects")
    .select("format, style, character_description, presenter_focus, content, voice_inclination")
    .eq("id", projectId)
    .single();

  const format = project?.format || "landscape";
  const style = project?.style || "realistic";
  const characterDescription = project?.character_description || "";
  const presenterFocus = project?.presenter_focus || "";
  const contentContext = project?.content || "";
  const language = project?.voice_inclination || "en";

  // Get the full style prompt (e.g., "Photorealistic cinematic photography...")
  const stylePrompt = getStylePrompt(style, undefined, "cinematic");

  // Get character bible from scene _meta if available (generated by the LLM)
  const characterBible: Record<string, string> = (scenes[0] as any)?._meta?.characterBible || {};

  // ── Determine input image ────────────────────────────────────────
  // Scene 0: use generated image
  // Scene N > 0: use last frame of previous scene's video
  let inputImageUrl: string;

  if (sceneIndex === 0) {
    // First scene — use the generated image
    inputImageUrl = scene.imageUrl;

    if (!inputImageUrl) {
      console.log(`[CinematicVideo] Scene 0 has no imageUrl — generating image first`);
      const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
      const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
      const prompt = scene.visualPrompt || scene.visual_prompt || "Cinematic scene";

      inputImageUrl = await generateImage(prompt, hyperealApiKey, replicateApiKey, format, projectId);
      await updateSceneField(generationId, sceneIndex, "imageUrl", inputImageUrl);
    }

    console.log(`[CinematicVideo] Scene 0: using generated image`);
  } else {
    // Scene N > 0 — wait for previous scene's video, extract last frame
    const prevVideoUrl = await waitForPreviousSceneVideo(generationId, sceneIndex - 1);

    if (prevVideoUrl) {
      console.log(`[CinematicVideo] Scene ${sceneIndex}: extracting last frame from scene ${sceneIndex - 1} video`);
      inputImageUrl = await extractAndUploadLastFrame(prevVideoUrl, projectId, sceneIndex);
    } else {
      // Fallback: use this scene's own generated image if previous video isn't available
      console.warn(`[CinematicVideo] Scene ${sceneIndex}: previous video not available — falling back to generated image`);
      inputImageUrl = scene.imageUrl;

      if (!inputImageUrl) {
        const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
        const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
        const prompt = scene.visualPrompt || scene.visual_prompt || "Cinematic scene";
        inputImageUrl = await generateImage(prompt, hyperealApiKey, replicateApiKey, format, projectId);
        await updateSceneField(generationId, sceneIndex, "imageUrl", inputImageUrl);
      }
    }
  }

  const sourceImageUrl = inputImageUrl;

  // Snapshot history for undo if regenerating
  if (regenerate) {
    const history = Array.isArray(scene._history) ? [...scene._history] : [];
    history.push({ timestamp: new Date().toISOString(), videoUrl: scene.videoUrl });
    if (history.length > 5) history.shift();
    scenes[sceneIndex]._history = history;
    await supabase.from("generations").update({ scenes }).eq("id", generationId);
  }

  // ── Build prompt with full context ───────────────────────────────
  const visualPrompt = scene.visualPrompt || scene.visual_prompt || "";
  const voiceover = scene.voiceover || "";
  const videoPrompt = buildVideoPrompt({
    visualPrompt,
    voiceover,
    characterDescription,
    presenterFocus,
    stylePrompt,
    styleName: style,
    characterBible,
    contentContext,
    language,
    sceneIndex,
    totalScenes: scenes.length,
  });

  // ── Generate video with Grok ─────────────────────────────────────
  console.log(`[CinematicVideo] Scene ${sceneIndex}: generating video with Grok from ${sceneIndex === 0 ? "generated image" : `scene ${sceneIndex - 1} last frame`}`);

  const grokResult = await generateGrokVideo({
    prompt: videoPrompt,
    imageUrl: inputImageUrl,
    format,
  });

  if (!grokResult.url) {
    throw new Error(`Video generation failed for scene ${sceneIndex}: ${grokResult.error}`);
  }

  console.log(`[CinematicVideo] Scene ${sceneIndex}: ✅ ${grokResult.provider} succeeded`);
  const finalVideoUrl = await uploadVideoToStorage(grokResult.url, projectId, generationId, sceneIndex);

  // ── Stale-image guard (only for scene 0) ─────────────────────────
  if (sceneIndex === 0) {
    const { data: freshGen } = await supabase
      .from("generations")
      .select("scenes")
      .eq("id", generationId)
      .maybeSingle();

    const freshScenes = (freshGen?.scenes as any[]) ?? [];
    const freshImageUrl = freshScenes[sceneIndex]?.imageUrl;

    if (freshImageUrl && freshImageUrl !== sourceImageUrl) {
      console.warn(`[CinematicVideo] Scene ${sceneIndex}: imageUrl changed — discarding stale video`);
      await writeSystemLog({
        jobId, projectId, userId, generationId,
        category: "system_info",
        eventType: "cinematic_video_stale_discarded",
        message: `Scene ${sceneIndex} video discarded — source image was regenerated`,
      });
      return { success: true, status: "stale_discarded", videoUrl: null, sceneIndex };
    }
  }

  // Atomic update
  await updateSceneField(generationId, sceneIndex, "videoUrl", finalVideoUrl);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_video_completed",
    message: `Cinematic video completed for scene ${sceneIndex} (${grokResult.provider}, chained from ${sceneIndex === 0 ? "image" : `scene ${sceneIndex - 1}`})`,
  });

  return { success: true, status: "complete", videoUrl: finalVideoUrl, sceneIndex, provider: grokResult.provider };
}

// ── Prompt builder ─────────────────────────────────────────────────

interface PromptInput {
  visualPrompt: string;
  voiceover: string;
  characterDescription: string;
  presenterFocus: string;
  stylePrompt: string;
  styleName: string;
  characterBible: Record<string, string>;
  contentContext: string;
  language: string;
  sceneIndex: number;
  totalScenes: number;
}

/**
 * Build a video prompt that stays UNDER 2500 chars.
 * Grok/Hypereal APIs time out on long prompts. Keep it tight.
 * The starting image already carries style, character, and context —
 * the prompt only needs to describe MOTION and ACTION.
 */
function buildVideoPrompt(input: PromptInput): string {
  const MAX_CHARS = 2400;
  const parts: string[] = [];

  // 1. Style (short)
  parts.push(`STYLE: ${input.styleName.toUpperCase()}. Maintain this exact visual style. Do not mix styles.`);

  // 2. Character (condensed — the image already shows them)
  if (input.characterDescription) {
    parts.push(`CHARACTER: ${input.characterDescription.substring(0, 200)}. Keep EXACT same appearance throughout.`);
  }

  // 3. Scene visual — the most important part
  parts.push(input.visualPrompt.substring(0, 600));

  // 4. Voiceover context (condensed — just the emotional/action cues)
  if (input.voiceover) {
    parts.push(`CONTEXT: ${input.voiceover.substring(0, 250)}`);
  }

  // 5. Language for text
  if (input.language && input.language !== "en") {
    const langName = input.language === "fr" ? "French" : input.language === "ht" ? "Haitian Creole" : input.language;
    parts.push(`Any visible text must be in ${langName}.`);
  }

  // 6. Rules (compact)
  parts.push(
    `RULES: No talking, no lip movement, no addressing camera. ` +
    `Rich facial expressions (shock, joy, fear, anger). ` +
    `Dynamic body movement at natural speed. Never static. ` +
    `Camera in constant motion: dolly, pan, tilt, tracking. ` +
    `Match narration energy. Same character appearance throughout.`
  );

  // Join and enforce hard limit
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
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`Failed to download video: ${videoRes.status}`);

  const videoBuffer = await videoRes.arrayBuffer();
  const fileName = `${projectId}/${generationId}/scene_${sceneIndex}_${Date.now()}.mp4`;

  const { error: uploadError } = await supabase.storage
    .from("scene-videos")
    .upload(fileName, videoBuffer, { contentType: "video/mp4", upsert: true });

  if (uploadError) throw new Error(`Failed to upload video: ${uploadError.message}`);

  const { data: publicUrlData } = supabase.storage
    .from("scene-videos")
    .getPublicUrl(fileName);

  return publicUrlData.publicUrl;
}
