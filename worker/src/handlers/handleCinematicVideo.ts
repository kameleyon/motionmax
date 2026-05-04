/**
 * Cinematic video handler — Kling V3.0 Pro I2V (active, end-to-end).
 *
 * Flow:
 *   - All images are generated FIRST (in parallel batches by the frontend)
 *   - ALL scenes use Kling V3.0 Pro I2V with native `end_image` for
 *     seamless start→end frame transitions between scenes.
 *   - Camera motion varies per scene (rotated from 7 movement types)
 *
 * Active: kling-3-0-pro-i2v via Hypereal (5s or 10s). Strongest
 * subject + texture fidelity in the Kling lineup; chosen for first-time
 * generation AND per-scene regenerations — no provider split.
 *
 * Previously active (rolled back): V2.6 Pro (cheaper but lower fidelity),
 * Grok Video I2V (status-lookup failures on Hypereal), V2.5 Turbo.
 *
 * Commented-out alternatives kept for quick rollback: Grok, Kling V3.0
 * Std, Kling V2.6 Pro, Kling V2.5 Turbo, Veo 3.1, PixVerse V6.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateImage } from "../services/imageGenerator.js";
import { retryDbRead } from "../lib/retryClassifier.js";
import {
  // generatePixVerseTransition,  // PixVerse V6 — disabled, returns 500 E1001
  // generateKlingV25Video,       // Kling V2.5 Turbo — retired
  // generateKlingV3Video,        // V3.0 Std — skipped; Pro variant below is used instead
  // generateVeo31Video,          // Veo 3.1 — doesn't follow prompts, generates unwanted audio/lip sync
  // generateKlingV26Video,       // Kling V2.6 Pro — retired, superseded by V3.0 Pro
  generateKlingV3ProVideo,        // Active model — Kling V3.0 Pro I2V (kling-3-0-pro-i2v).
  // generateGrokVideo,           // Grok Video I2V — status-lookup failures on Hypereal, rolled back
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
  const { data: generation, error: genError } = await retryDbRead(() =>
    supabase
      .from("generations")
      .select("scenes")
      .eq("id", generationId)
      .maybeSingle()
  );

  if (genError || !generation) {
    throw new Error(`Generation not found: ${genError?.message}`);
  }

  const scenes = generation.scenes as any[];
  const scene = scenes[sceneIndex];
  if (!scene) throw new Error(`Scene ${sceneIndex} not found`);

  const totalScenes = scenes.length;
  const isLastScene = sceneIndex === totalScenes - 1;

  // Fetch project data. Keep the core select to columns that are
  // guaranteed on every deploy; the optional `intake_settings` column
  // is read in a separate defensive query so pre-migration DBs don't
  // break scene rendering.
  const { data: project } = await supabase
    .from("projects")
    .select("format, style, custom_style, character_description, voice_inclination, character_images")
    .eq("id", projectId)
    .single();

  let intake: Record<string, unknown> = {};
  try {
    const { data: proj } = await supabase
      .from("projects")
      .select("intake_settings")
      .eq("id", projectId)
      .maybeSingle();
    if (proj && (proj as { intake_settings?: Record<string, unknown> }).intake_settings) {
      intake = (proj as { intake_settings: Record<string, unknown> }).intake_settings;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CinematicVideo] intake_settings lookup skipped: ${msg}`);
  }

  const format = project?.format || "landscape";
  const styleId = project?.style || "realistic";
  // Intake settings shape: { camera?: string, grade?: string, lipSync?, music?, ... }
  // "Default" = let the AI pick (rotates per scene via getCameraMotion).
  // Anything else is a hard override the user explicitly chose.
  //
  // Camera-source priority (per-scene):
  //   1. scene._meta.motion — set by the editor's Inspector per-scene picker.
  //   2. intake_settings.camera — initial intake form choice (project-wide).
  //   3. Rotated default list via getCameraMotion(sceneIndex) for visual variety.
  // "Default" or "Still" cancels the override and falls back to the rotation.
  const sceneMotion = typeof scene?._meta?.motion === "string" ? scene._meta.motion : null;
  const rawCamera = sceneMotion ?? (typeof intake.camera === "string" ? intake.camera : null);
  const userCameraOverride =
    rawCamera && rawCamera !== "Default" && rawCamera !== "Still" ? rawCamera : null;
  // Color grade: scene._meta.grade overrides intake_settings.grade. The
  // export pipeline also applies grade as an FFmpeg color filter at
  // mux time, but injecting it into the Kling prompt biases the i2v
  // generation toward matching tones — so we keep both layers.
  const sceneGrade = typeof scene?._meta?.grade === "string" ? scene._meta.grade : null;
  const userColorGrade = sceneGrade ?? (typeof intake.grade === "string" ? intake.grade : null);
  const { getStylePrompt: getStyle, getStyleNegativePrompt } = await import("../services/prompts.js");
  const styleDesc = getStyle(styleId);
  // Style-specific negative tokens (e.g. "no photorealistic humans" for
  // cardboard/clay/lego/etc). Empty string for realistic style.
  const styleNegative = getStyleNegativePrompt(styleId, project?.custom_style);
  const userCharacterDesc = project?.character_description || "";
  const characterImages: string[] = (project as any)?.character_images || [];

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
    imageUrl = await generateImage(
      prompt, hyperealApiKey, replicateApiKey, format, projectId,
      characterImages.length > 0 ? characterImages : undefined,
    );
    await updateSceneField(generationId, sceneIndex, "imageUrl", imageUrl);
  }

  const sourceImageUrl = imageUrl;

  // ── Get next scene's image (for end_image transition) ────────────
  let endImageUrl: string | undefined;
  if (!isLastScene) {
    endImageUrl = scenes[sceneIndex + 1]?.imageUrl;

    if (!endImageUrl) {
      // The dependency system guarantees image[i+1] is complete before this job starts.
      // Do a quick re-fetch in case the cached scenes row is stale (e.g. DB write race).
      console.log(`[CinematicVideo] Scene ${sceneIndex}: next image not in cached scenes — re-fetching DB`);
      const { data: freshGen } = await supabase
        .from("generations")
        .select("scenes")
        .eq("id", generationId)
        .maybeSingle();
      const freshScenes = (freshGen?.scenes as any[]) ?? [];
      endImageUrl = freshScenes[sceneIndex + 1]?.imageUrl;

      if (!endImageUrl) {
        // Dep guarantee failed (should not happen) — generate the missing image as fallback
        console.warn(`[CinematicVideo] Scene ${sceneIndex}: next scene image missing after dep gate — generating fallback`);
        const hyperealApiKey = (process.env.HYPEREAL_API_KEY || "").trim();
        const replicateApiKey = (process.env.REPLICATE_API_KEY || "").trim();
        const nextScene = freshScenes[sceneIndex + 1];
        const nextPrompt = nextScene?.visualPrompt || nextScene?.visual_prompt || "Cinematic scene";
        try {
          endImageUrl = await generateImage(
            nextPrompt, hyperealApiKey, replicateApiKey, format, projectId,
            characterImages.length > 0 ? characterImages : undefined,
          );
          await updateSceneField(generationId, sceneIndex + 1, "imageUrl", endImageUrl);
        } catch {
          console.error(`[CinematicVideo] Scene ${sceneIndex}: fallback image gen failed, proceeding without end_image`);
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
  // When the user picked an explicit camera motion in the IntakeForm, use
  // it across every scene. Otherwise fall back to the scene-rotating
  // default list so the video still has visual variety.
  const cameraMotion = userCameraOverride
    ? userCameraOverride // user chose: "Dolly", "Handheld", "Drone", etc.
    : getCameraMotion(sceneIndex);
  const gradeDirective = userColorGrade
    ? `\nCOLOR GRADE: ${userColorGrade} — keep this look consistent across every frame (palette, contrast, film stock feel).`
    : "";
  const videoPrompt = buildVideoPrompt(visualPrompt, voiceover, characterDescription, styleDesc + gradeDirective, language, cameraMotion);

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
    `[CinematicVideo] Scene ${sceneIndex}: Kling V3.0 Pro I2V${regenerate ? " (regen)" : ""}, ` +
    `camera=${cameraName}, prompt=${finalPrompt.length} chars`
  );

  // ── Generate video ────────────────────────────────────────────────
  let videoUrl: string;
  let provider: string;
  // Base negatives + style-specific anti-realism tokens (when style is
  // non-realistic). Comma-joined so Kling parses them as one negative
  // prompt list. Empty styleNegative is filtered out before joining.
  const baseNegatives = "blurry, low quality, watermark, text, UI elements, slow motion, sluggish, nudity, naked, exposed body, extra limbs, body contortion, distorted anatomy, lip sync, talking, mouth movement, speaking";
  const negPrompt = [baseNegatives, styleNegative].filter(Boolean).join(", ");

  // ── Per-scene Kling rejection fallback ──────────────────────────────
  // Kling 3.0 Pro's risk-control system permanently rejects some prompts
  // ("Failure to pass the risk control system"). Before this fallback,
  // a single rejected scene blew up the whole render (markRunFailed
  // surfaced "kling: Failure to pass the risk control system" and the
  // user got nothing — even though 11 of 12 scenes succeeded).
  //
  // Three options were on the table:
  //   1. Retry with a softened prompt — moderation is opaque and
  //      keyword-stripping rarely flips the verdict on a second try; one
  //      extra Kling call costs ~10–60s and another ~15–35 credits.
  //   2. Skip the scene — but the audio track is one continuous master
  //      file (handleMasterAudio) timed against scene boundaries, so
  //      removing scene N would desync every later scene's voiceover.
  //   3. Hold-frame: keep the still image, return null videoUrl. The
  //      finalize+export path already handles scenes that have only
  //      imageUrl (exportVideo.ts:128 `s.videoUrl || s.imageUrl || ...`),
  //      Ken-Burns or static — so the user gets a visually intact final
  //      mp4 with one held shot instead of a 100% loss.
  //
  // We picked #3. It's the only option that produces a watchable result
  // on a single Kling rejection, and the existing export pipeline
  // already supports it without changes. We surface the choice via
  // the return payload so handleAutopostRun can stamp error_summary
  // ("scene N held as still frame: Kling moderation").
  provider = "Kling V3.0 Pro I2V";
  let heldFrameReason: string | null = null;

  try {
    videoUrl = await generateKlingV3ProVideo(
      imageUrl,
      finalPrompt,
      apiKey,
      10,
      endImageUrl,
      negPrompt,
      0.5,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Treat moderation rejection as a permanent per-scene failure —
    // never retry and never bubble. Anything else (transient API,
    // timeout, etc.) we re-throw so the dispatcher's retry policy
    // gets a shot at it.
    const isModerationReject = /risk control|content[_ ]?violation|blocked.*content|moderation/i.test(errMsg);
    if (!isModerationReject) {
      throw err;
    }
    heldFrameReason = `Kling moderation rejected scene ${sceneIndex}; held still image as frame`;
    console.warn(`[CinematicVideo] Scene ${sceneIndex}: ${heldFrameReason} — ${errMsg}`);
    await writeSystemLog({
      jobId, projectId, userId, generationId,
      category: "system_warning",
      eventType: "cinematic_video_held_frame_fallback",
      message: `Scene ${sceneIndex}: Kling rejected — using still image as held frame`,
      details: {
        sceneIndex,
        provider: "Kling V3.0 Pro I2V",
        reason: errMsg,
        fallback: "hold_frame",
      },
    });

    // Mark the scene with a hold-frame sentinel. videoUrl stays null;
    // export pipeline picks up imageUrl and renders a static shot for
    // this scene's audio duration. _meta.heldFrame lets the editor /
    // RunDetail surface "this scene was held" if the user opens it.
    const { data: freshGen2 } = await supabase
      .from("generations").select("scenes").eq("id", generationId).maybeSingle();
    const freshScenes2 = ((freshGen2?.scenes as any[]) ?? []).slice();
    if (freshScenes2[sceneIndex]) {
      const meta = (freshScenes2[sceneIndex]._meta && typeof freshScenes2[sceneIndex]._meta === "object")
        ? { ...freshScenes2[sceneIndex]._meta }
        : {};
      meta.heldFrame = {
        reason: errMsg.slice(0, 240),
        provider: "kling-3-0-pro-i2v",
        at: new Date().toISOString(),
      };
      freshScenes2[sceneIndex] = { ...freshScenes2[sceneIndex], videoUrl: null, _meta: meta };
      await supabase.from("generations").update({ scenes: freshScenes2 }).eq("id", generationId);
    }

    await writeSystemLog({
      jobId, projectId, userId, generationId,
      category: "system_warning",
      eventType: "cinematic_video_completed",
      message: `Cinematic video for scene ${sceneIndex} held as still frame (Kling moderation)`,
      details: { provider, hasTransition: !!endImageUrl, cost: 0, fallback: "hold_frame", reason: errMsg },
    });

    return {
      success: true,
      status: "held_frame",
      videoUrl: null,
      sceneIndex,
      provider,
      hasTransition: false,
      cost: 0,
      heldFrame: true,
      heldFrameReason,
    };
  }

  // Rollback references (all commented out):
  //
  // Kling V2.6 Pro I2V (superseded by V3.0 Pro):
  //   provider = "Kling V2.6 Pro I2V";
  //   videoUrl = await generateKlingV26Video(imageUrl, finalPrompt, apiKey, 10, endImageUrl, negPrompt, 0.5);
  //
  // Grok Video I2V (Hypereal status-lookup failures — every fresh job
  // died ~5s after creation with "Failed to check status"):
  //   const aspectRatio = format === "portrait" ? "9:16" as const : "16:9" as const;
  //   provider = "Grok Video I2V";
  //   videoUrl = await generateGrokVideo(imageUrl, finalPrompt, apiKey, aspectRatio, 10, "1080P");

  // Upload to Supabase storage
  let finalVideoUrl = await uploadVideoToStorage(videoUrl, projectId, generationId, sceneIndex);

  // ── Optional lip-sync pass ────────────────────────────────────────
  // If the user enabled Lip Sync in the new IntakeForm, run the scene
  // through Hypereal's lip-sync model using this scene's narration
  // audio. Failures are swallowed — the user still gets the Kling
  // video, they just don't get mouth alignment on it. This mirrors
  // music-gen finalize behaviour where additive features degrade
  // gracefully rather than nuking the whole generation.
  const lipSyncCfg = (intake as { lipSync?: { on?: boolean; strength?: number } }).lipSync;
  const sceneAudioUrl = scene.audioUrl as string | undefined;
  if (lipSyncCfg?.on && sceneAudioUrl) {
    try {
      const { applyLipSync } = await import("../services/lipSync.js");
      const res = await applyLipSync({
        videoUrl: finalVideoUrl,
        audioUrl: sceneAudioUrl,
        strength: lipSyncCfg.strength ?? 70,
        apiKey,
      });
      if (res.applied) {
        console.log(`[CinematicVideo] Scene ${sceneIndex}: lip-sync applied`);
        finalVideoUrl = res.videoUrl;
      } else {
        console.warn(`[CinematicVideo] Scene ${sceneIndex}: lip-sync skipped — ${res.reason}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[CinematicVideo] Scene ${sceneIndex}: lip-sync threw — ${msg}`);
    }
  }

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
