/**
 * Cinematic video handler.
 *
 * Generates video per scene using Kling I2V with seamless morphing:
 *   - image = Scene N's generated image (start frame)
 *   - end_image = Scene N+1's generated image (end frame / morph target)
 *   - prompt = Scene N's visual + voiceover context + character + morph instruction
 *   - duration = matched to audio length (5, 10, or 15s)
 *
 * Each clip IS both the scene AND the transition to the next scene.
 * Audio is muxed during export. Clips concat directly — no crossfade needed.
 *
 * Provider chain:
 *   Primary:  Kling V3.0 Std I2V (kling-3-0-std-i2v)
 *   Fallback: Kling V2.6 Pro I2V (kling-2-6-i2v-pro)
 *   // Grok — commented out (replaced by Kling for native end_image support)
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateImage } from "../services/imageGenerator.js";
import {
  generateKlingV3Video,
  generateKlingV26Video,
} from "../services/hypereal.js";

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
 * Pick the Kling duration that covers the audio length.
 * Kling V3.0 accepts: 3, 5, 10, 15. V2.6 accepts: 5, 10.
 * We use V3.0 durations since it's the primary.
 */
function pickKlingDuration(audioDurationSec: number): number {
  if (audioDurationSec <= 5) return 5;
  if (audioDurationSec <= 10) return 10;
  return 15; // max for Kling V3.0
}

/**
 * Wait for the next scene's image to be available in the DB.
 * The cinematic pipeline dispatches images and videos in parallel —
 * the next scene's image might not be ready yet when this scene's
 * video starts generating. Poll up to 60s before giving up.
 */
async function waitForNextSceneImage(
  generationId: string,
  nextSceneIndex: number,
  maxWaitMs: number = 60_000
): Promise<string | null> {
  const startTime = Date.now();
  const pollInterval = 5_000;

  while (Date.now() - startTime < maxWaitMs) {
    const { data: gen } = await supabase
      .from("generations")
      .select("scenes")
      .eq("id", generationId)
      .maybeSingle();

    const scenes = (gen?.scenes as any[]) ?? [];
    const nextImageUrl = scenes[nextSceneIndex]?.imageUrl;

    if (nextImageUrl) {
      console.log(`[CinematicVideo] Next scene ${nextSceneIndex} image ready after ${Math.round((Date.now() - startTime) / 1000)}s`);
      return nextImageUrl;
    }

    await sleep(pollInterval);
  }

  console.warn(`[CinematicVideo] Next scene ${nextSceneIndex} image not ready after ${maxWaitMs / 1000}s — proceeding without morph target`);
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

  // ── Fetch project data (format + character description) ──────────
  const { data: project } = await supabase
    .from("projects")
    .select("format, character_description, presenter_focus, style")
    .eq("id", projectId)
    .single();

  const format = project?.format || "landscape";
  const characterDescription = project?.character_description || "";
  const presenterFocus = project?.presenter_focus || "";

  let imageUrl = scene.imageUrl;

  // Auto-generate image if missing
  if (!imageUrl) {
    console.log(`[CinematicVideo] Scene ${sceneIndex} has no imageUrl — generating image first`);
    const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
    const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
    const prompt = scene.visualPrompt || scene.visual_prompt || "Cinematic scene";

    imageUrl = await generateImage(prompt, hyperealApiKey, replicateApiKey, format, projectId);
    await updateSceneField(generationId, sceneIndex, "imageUrl", imageUrl);
    console.log(`[CinematicVideo] Scene ${sceneIndex} image auto-generated`);
  }

  const sourceImageUrl = imageUrl;

  // Snapshot history for undo if regenerating
  if (regenerate) {
    const history = Array.isArray(scene._history) ? [...scene._history] : [];
    history.push({ timestamp: new Date().toISOString(), videoUrl: scene.videoUrl });
    if (history.length > 5) history.shift();
    scenes[sceneIndex]._history = history;
    await supabase.from("generations").update({ scenes }).eq("id", generationId);
  }

  // ── Determine video duration from audio length ───────────────────
  // Estimate from voiceover word count if audio not yet available
  const voiceover: string = scene.voiceover || "";
  const wordCount = voiceover.split(/\s+/).filter(Boolean).length;
  const estimatedAudioSec = Math.max(5, wordCount / 2.5); // ~150 words per minute
  const klingDuration = pickKlingDuration(estimatedAudioSec);

  console.log(
    `[CinematicVideo] Scene ${sceneIndex}: voiceover=${wordCount} words, ` +
    `estimated=${estimatedAudioSec.toFixed(1)}s, kling duration=${klingDuration}s`
  );

  // ── Get next scene's image for morph target ──────────────────────
  const isLastScene = sceneIndex >= scenes.length - 1;
  let nextImageUrl: string | null = null;

  if (!isLastScene) {
    // First check if it's already in the scenes array we have
    nextImageUrl = scenes[sceneIndex + 1]?.imageUrl || null;

    // If not ready, wait for it (the pipeline generates images in parallel)
    if (!nextImageUrl) {
      console.log(`[CinematicVideo] Scene ${sceneIndex}: waiting for scene ${sceneIndex + 1} image...`);
      nextImageUrl = await waitForNextSceneImage(generationId, sceneIndex + 1);
    }

    if (nextImageUrl) {
      console.log(`[CinematicVideo] Scene ${sceneIndex}: will morph into scene ${sceneIndex + 1}`);
    } else {
      console.log(`[CinematicVideo] Scene ${sceneIndex}: no morph target available`);
    }
  } else {
    console.log(`[CinematicVideo] Scene ${sceneIndex}: last scene — no morph`);
  }

  // ── Build prompt with full context ───────────────────────────────
  const visualPrompt = scene.visualPrompt || scene.visual_prompt || "";
  const videoPrompt = buildVideoPrompt(
    visualPrompt,
    voiceover,
    characterDescription,
    presenterFocus,
    !!nextImageUrl
  );

  const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
  if (!hyperealApiKey) {
    throw new Error("HYPEREAL_API_KEY is not configured");
  }

  // ── Generate video: Kling V3.0 → Kling V2.6 fallback ────────────
  let finalVideoUrl: string | null = null;
  let provider = "";

  // Primary: Kling V3.0
  try {
    console.log(`[CinematicVideo] Scene ${sceneIndex}: trying Kling V3.0 (${klingDuration}s)...`);
    const url = await generateKlingV3Video(
      imageUrl,
      videoPrompt,
      hyperealApiKey,
      klingDuration,
      nextImageUrl || undefined,
    );
    if (url) {
      provider = "Kling V3.0";
      finalVideoUrl = await uploadVideoToStorage(url, projectId, generationId, sceneIndex);
      console.log(`[CinematicVideo] Scene ${sceneIndex}: ✅ ${provider} succeeded`);
    }
  } catch (err: any) {
    console.warn(`[CinematicVideo] Scene ${sceneIndex}: ❌ Kling V3.0 failed — ${err?.message || err}`);
  }

  // Fallback: Kling V2.6
  if (!finalVideoUrl) {
    try {
      // Kling V2.6 only supports 5 or 10 — clamp
      const v26Duration = Math.min(klingDuration, 10);
      console.log(`[CinematicVideo] Scene ${sceneIndex}: trying Kling V2.6 fallback (${v26Duration}s)...`);
      const url = await generateKlingV26Video(
        imageUrl,
        videoPrompt,
        hyperealApiKey,
        v26Duration,
        nextImageUrl || undefined,
      );
      if (url) {
        provider = "Kling V2.6";
        finalVideoUrl = await uploadVideoToStorage(url, projectId, generationId, sceneIndex);
        console.log(`[CinematicVideo] Scene ${sceneIndex}: ✅ ${provider} succeeded`);
      }
    } catch (err: any) {
      console.warn(`[CinematicVideo] Scene ${sceneIndex}: ❌ Kling V2.6 failed — ${err?.message || err}`);
    }
  }

  // ── Grok fallback — commented out (replaced by Kling) ──────────
  // if (!finalVideoUrl) {
  //   const grokResult = await generateGrokVideo({ prompt: videoPrompt, imageUrl, format });
  //   if (grokResult.url) {
  //     finalVideoUrl = await uploadVideoToStorage(grokResult.url, projectId, generationId, sceneIndex);
  //     provider = grokResult.provider;
  //   }
  // }

  if (!finalVideoUrl) {
    throw new Error(`Video generation failed for scene ${sceneIndex}: both Kling V3.0 and V2.6 failed`);
  }

  // ── Stale-image guard ────────────────────────────────────────────
  const { data: freshGen } = await supabase
    .from("generations")
    .select("scenes")
    .eq("id", generationId)
    .maybeSingle();

  const freshScenes = (freshGen?.scenes as any[]) ?? [];
  const freshImageUrl = freshScenes[sceneIndex]?.imageUrl;

  if (freshImageUrl && freshImageUrl !== sourceImageUrl) {
    console.warn(
      `[CinematicVideo] Scene ${sceneIndex}: imageUrl changed while video was generating — discarding stale video`,
    );
    await writeSystemLog({
      jobId, projectId, userId, generationId,
      category: "system_info",
      eventType: "cinematic_video_stale_discarded",
      message: `Scene ${sceneIndex} video discarded — source image was regenerated during generation`,
    });
    return { success: true, status: "stale_discarded", videoUrl: null, sceneIndex };
  }

  await updateSceneField(generationId, sceneIndex, "videoUrl", finalVideoUrl);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_video_completed",
    message: `Cinematic video completed for scene ${sceneIndex} (${provider}, ${klingDuration}s)`,
  });

  return { success: true, status: "complete", videoUrl: finalVideoUrl, sceneIndex, provider };
}

// ── Prompt builder ─────────────────────────────────────────────────

function buildVideoPrompt(
  visualPrompt: string,
  voiceover: string,
  characterDescription: string,
  presenterFocus: string,
  hasMorphTarget: boolean
): string {
  const parts: string[] = [];

  // Character identity — MUST come first for consistency
  if (characterDescription) {
    parts.push(`CHARACTER (maintain exact appearance throughout): ${characterDescription}`);
  }
  if (presenterFocus) {
    parts.push(`SUBJECT FOCUS: ${presenterFocus}`);
  }

  // Scene visual description
  parts.push(visualPrompt);

  // Voiceover context — tells the AI what's happening in this scene
  if (voiceover) {
    parts.push(`SCENE CONTEXT (what is being narrated): ${voiceover.substring(0, 300)}`);
  }

  // Animation rules
  parts.push(`
ANIMATION RULES:
- NO lip-sync talking animation — characters must NOT move their mouths as if speaking
- Facial expressions ARE allowed: surprised, shocked, screaming, laughing, crying, angry
- Body movement IS required: walking, running, gesturing, pointing, reacting — at NATURAL pace
- Environment animation IS required: wind, particles, camera movement, lighting changes
- All motion must be DYNAMIC and at natural human speed — never slow motion
- Camera must be in constant motion: dolly, pan, tilt, tracking — never static
- Match the energy of the narration — if the scene is intense, the motion must be intense`);

  // Morph transition instruction
  if (hasMorphTarget) {
    parts.push(`
TRANSITION (CRITICAL — final 3 seconds):
- The camera pushes forward with increasing momentum
- The environment seamlessly morphs, stretches, and melts into the provided ending frame
- This morphing is fluid and continuous — no hard cuts, no fades to black
- Objects in the foreground dissolve and reshape into the next scene as the camera passes them`);
  }

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
