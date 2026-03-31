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

function buildVideoPrompt(input: PromptInput): string {
  const parts: string[] = [];

  // ── 1. STYLE LOCK — prevents mixing art styles ──
  parts.push(
    `VISUAL STYLE (STRICT — do NOT deviate): ${input.styleName.toUpperCase()} style. ` +
    `${input.stylePrompt.substring(0, 400)}. ` +
    `Maintain this EXACT visual style throughout. Do NOT mix with other styles. ` +
    `If the style is realistic, everything must look photorealistic. ` +
    `If the style is anime, everything must look anime. No exceptions.`
  );

  // ── 2. CHARACTER IDENTITY — detailed and enforced ──
  if (input.characterDescription) {
    parts.push(
      `MAIN CHARACTER (CRITICAL — maintain EXACT appearance in every frame):\n${input.characterDescription}\n` +
      `The character's skin tone, hair, clothing, body type, and facial features must remain IDENTICAL ` +
      `to the provided starting image throughout the entire video. Do NOT change the character's ` +
      `race, gender, age, hair color/style, or clothing. This is the SAME person from frame 1 to the last frame.`
    );
  }

  // ── 3. CHARACTER BIBLE — if LLM generated specific character refs ──
  const bibleEntries = Object.entries(input.characterBible);
  if (bibleEntries.length > 0) {
    const bibleText = bibleEntries
      .map(([name, desc]) => `  • ${name}: ${desc}`)
      .join("\n");
    parts.push(`CHARACTER REFERENCE SHEET:\n${bibleText}`);
  }

  if (input.presenterFocus) {
    parts.push(`SUBJECT FOCUS: ${input.presenterFocus}`);
  }

  // ── 4. SCENE VISUAL DESCRIPTION — what this scene shows ──
  parts.push(`SCENE ${input.sceneIndex + 1}/${input.totalScenes} VISUAL:\n${input.visualPrompt}`);

  // ── 5. NARRATIVE CONTEXT — what's happening, NOT what's being said ──
  if (input.voiceover) {
    parts.push(
      `SCENE CONTEXT (what is happening in this moment — use for action/emotion cues only):\n"${input.voiceover.substring(0, 500)}"`
    );
  }

  // ── 6. CONTENT/HISTORICAL CONTEXT — keeps accuracy ──
  if (input.contentContext && input.contentContext.length > 20) {
    parts.push(
      `CONTENT CONTEXT (maintain accuracy to this source material):\n${input.contentContext.substring(0, 300)}`
    );
  }

  // ── 7. LANGUAGE — text consistency ──
  const langName = input.language === "fr" ? "French" : input.language === "ht" ? "Haitian Creole" : "English";
  parts.push(
    `LANGUAGE & TEXT: Any text, titles, signs, letters, or written content visible in the video must be in ${langName}. ` +
    `Maintain language consistency throughout.`
  );

  // ── 8. ANIMATION RULES ──
  parts.push(
    `ANIMATION RULES (MANDATORY):\n` +
    `- Characters must NEVER talk, narrate, commentate, or address the audience\n` +
    `- Characters must NEVER move their mouths as if speaking, presenting, or explaining\n` +
    `- Characters must NEVER look directly at the camera as if talking to the viewer\n` +
    `- Even if the script is in first person, characters do NOT speak — the voiceover is separate\n` +
    `- Characters CAN interact with each other through gestures, body language, and expressions\n` +
    `- Facial expressions must be RICH and DETAILED: shock, fury, grief, joy, fear, determination, disgust\n` +
    `- Body movement IS required: walking, running, gesturing, pointing, reacting — NEVER static\n` +
    `- ALL motion at NATURAL human speed — never slow motion, never unnaturally fast\n` +
    `- Environment animation required: wind, particles, camera movement, lighting changes\n` +
    `- Camera must be in constant motion: dolly, pan, tilt, tracking — never static\n` +
    `- Match the energy of the narration — intense narration = intense motion\n` +
    `- Maintain CONSISTENT character appearance — same person, same clothes, same features across all scenes`
  );

  return parts.join("\n\n");
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
