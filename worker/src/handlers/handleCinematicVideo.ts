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
import { audit, auditError } from "../lib/audit.js";
import { updateSceneField } from "../lib/sceneUpdate.js";
import { generateImage } from "../services/imageGenerator.js";
import { retryDbRead } from "../lib/retryClassifier.js";
import {
  // generatePixVerseTransition,  // PixVerse V6 — disabled, returns 500 E1001
  // generateKlingV25Video,       // Kling V2.5 Turbo — retired
  // generateKlingV3Video,        // V3.0 Std — skipped; Pro variant below is used instead
  // generateVeo31Video,          // Veo 3.1 — doesn't follow prompts, generates unwanted audio/lip sync
  // generateKlingV26Video,       // Kling V2.6 Pro — retired, superseded by V3.0 Pro
  generateSeedance2I2V,           // Primary — Seedance 2.0 I2V (seedance-2-0-i2v, from 58 cr). Reverted from Turbo 2026-05-07.
  generateKlingV3ProI2V,          // Fallback — Kling V3.0 Pro I2V (kling-3-0-pro-i2v, 39 cr). Tried after 2 failed Seedance attempts.
  // generateGrokVideo,           // Grok Video I2V — status-lookup failures on Hypereal, rolled back
  pollHyperealJob,                // Resume-from-checkpoint poll for an already-submitted Hypereal job.
} from "../services/hypereal.js";
import { saveCheckpoint, readCheckpointKey, clearCheckpointKey, CheckpointReadError } from "../lib/checkpoint.js";
import { isKillSwitchArmed } from "../lib/featureFlags.js";

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

  // Phase 17.3 kill-switch — admins can pause cinematic video
  // generation via the admin Kill Switches tab. Fail-fast at handler
  // entry so the queue surfaces the reason in error_message instead
  // of running through the full prompt + Hypereal submit path.
  // Renamed 2026-05-08 from "video_generation" → "pause_video" to
  // avoid collision with the legacy positive-semantic flag of the
  // same name. See migration 20260508240000.
  if (await isKillSwitchArmed("pause_video")) {
    throw new Error("Cinematic video generation is paused by an administrator (kill switch: pause_video).");
  }

  await audit("video.gen_started", {
    jobId, projectId, userId, generationId,
    message: `Cinematic video started for scene ${sceneIndex}`,
    details: { sceneIndex, regenerate: !!regenerate },
  });

  try {
    return await _runCinematicVideo(jobId, payload, userId);
  } catch (err) {
    await auditError("video.gen_failed", err, {
      jobId, projectId, userId, generationId,
      details: { sceneIndex, regenerate: !!regenerate },
    });
    throw err;
  }
}

async function _runCinematicVideo(
  jobId: string,
  payload: CinematicVideoPayload,
  userId?: string,
) {
  const { generationId, projectId, sceneIndex, regenerate } = payload;

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

  const scenes = (generation.scenes ?? null) as any[] | null;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error(`Generation ${generationId} has no scenes (got ${scenes === null ? "null" : typeof scenes})`);
  }
  const scene = scenes[sceneIndex];
  if (!scene) throw new Error(`Scene ${sceneIndex} not found (have ${scenes.length} scenes)`);

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
      { userId: userId ?? null, generationId },
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
            { userId: userId ?? null, generationId },
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
    `[CinematicVideo] Scene ${sceneIndex}: Seedance 2.0 I2V${regenerate ? " (regen)" : ""}, ` +
    `camera=${cameraName}, prompt=${finalPrompt.length} chars`
  );

  // Map project format → Seedance aspect_ratio. Seedance crops/pads
  // away from this aspect, so a portrait schedule with a hardcoded
  // 16:9 would render letterboxed in the final stitched mp4.
  const seedanceAspect: "16:9" | "9:16" | "1:1" =
    format === "portrait" ? "9:16"
    : format === "square" ? "1:1"
    : "16:9";

  // ── Generate video ────────────────────────────────────────────────
  // Nullable string so the retry-then-fallback chain can use `if (!videoUrl)`
  // to detect "still need to try Kling" without TS complaining about
  // possibly-uninitialized access.
  let videoUrl: string | null = null;
  let provider: string;
  // Seedance has no negative_prompt slot, so fold the prohibitions
  // directly into the positive prompt as a hard "AVOID" trailer.
  // Kept the original Kling negative list and added the user-flagged
  // failure modes from prod feedback: clothes morphing mid-shot,
  // characters clipping through furniture, faces twisted away from
  // their bodies, jerky camera moves. Also reinforces "smooth camera
  // motion + smooth transition" so transitions between scenes don't
  // snap.
  const motionGuardrails =
    "Camera motion is SMOOTH and continuous; transitions are SMOOTH (no jump cuts within the clip). " +
    // STYLE LOCK — the model receives a start image (and sometimes an
    // end image) that's already rendered in a specific art style:
    // realistic photo, paper-cutout, sketch, anime, watercolour, etc.
    // Hypereal occasionally re-renders these into glossy 3D — which
    // breaks visual continuity with surrounding scenes. Hard-lock the
    // style here. The instruction is repeated three different ways
    // because Kling's prompt parser weighs the strongest negative
    // associations more than positive descriptions.
    "PRESERVE the EXACT art style of the source image — same medium, same brush/line/shade rendering, same color palette, same level of stylisation. " +
    "DO NOT convert 2D / illustrated / paper / sketch / flat / cel-shaded / stylised images into 3D, photoreal, CGI, glossy, or volumetric renders. " +
    "If the start image is paper-cutout, keep paper-cutout. If it is hand-drawn or watercolour, keep hand-drawn or watercolour. " +
    "When transitioning from start image to end image, the in-between frames MUST stay in the same art style as both endpoints — no style morphing, no rendering-engine switch, no \"upgrade\" to realism. " +
    "AVOID: blurry, low quality, watermark, text, UI elements, slow motion, sluggish; " +
    "AVOID 3D-render look, CGI gloss, volumetric lighting, photorealistic conversion, plastic-doll faces, or any change in art style across the clip; " +
    "no nudity / naked / exposed body parts; no extra limbs, body contortion, or distorted anatomy; " +
    "no lip sync, talking, mouth movement, or speaking; " +
    "characters MUST NOT change clothes or outfits mid-shot; " +
    "characters MUST NOT pass or clip through furniture, walls, or props; " +
    "head and face MUST stay aligned with the body — no faces rotated opposite to the torso; " +
    "limbs and joints bend only in anatomically natural directions" +
    (styleNegative ? `; additional style restrictions: ${styleNegative}` : "");

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
  provider = "Seedance 2.0 I2V";
  let heldFrameReason: string | null = null;

  // Build a Kling-style negative prompt by extracting the AVOID list
  // from the motion guardrails. Kling V3 Pro supports negative_prompt
  // natively (Seedance does not, which is why guardrails are folded into
  // the positive prompt above).
  const klingNegativePrompt =
    "blurry, low quality, watermark, text, UI elements, slow motion, sluggish, " +
    "3D render, CGI, photorealistic conversion, glossy plastic, volumetric lighting, " +
    "art style change mid-clip, style morphing between frames, rendering-engine switch, " +
    "upgrading 2D illustration to 3D, paper-cutout becoming photoreal, sketch becoming CGI, " +
    "nudity, naked, exposed body parts, extra limbs, body contortion, distorted anatomy, " +
    "lip sync, talking, mouth movement, speaking, " +
    "characters changing clothes mid-shot, characters clipping through furniture or props, " +
    "faces rotated opposite to torso, limbs bending in unnatural directions" +
    (styleNegative ? `, ${styleNegative}` : "");

  // ── Resume from checkpoint ─────────────────────────────────────────
  // If a previous worker died after submitting a Hypereal job but before
  // polling completed, the provider jobId was saved to the checkpoint.
  // Resume polling directly — skips the prompt build + re-submit, which
  // would re-charge Hypereal credits for a job that's already running.
  const checkpointKey = `scene_${sceneIndex}`;
  // C-7-6: readCheckpointKey now throws CheckpointReadError on DB
  // failure (instead of silently returning undefined → "no checkpoint
  // → re-submit"). Let it propagate so withTransientRetry retries the
  // read; the job stays in 'processing' and Hypereal is NOT re-charged.
  let cp: {
    stage?: string;
    providerJobId?: string;
    pollUrl?: string | null;
    model?: string;
  } | undefined;
  try {
    cp = await readCheckpointKey(jobId, checkpointKey);
  } catch (err) {
    if (err instanceof CheckpointReadError) {
      // Surface as-is — retry-classifier marks CheckpointReadError as
      // transient, so withTransientRetry will re-invoke this handler
      // (which will hit the checkpoint again, this time hopefully
      // reading it cleanly). Critically: we do NOT fall through to a
      // fresh provider submit on a DB blip.
      throw err;
    }
    throw err;
  }
  if (cp?.stage === "polling" && typeof cp.providerJobId === "string" && typeof cp.model === "string") {
    console.log(
      `[CinematicVideo] Scene ${sceneIndex}: resuming Hypereal poll from checkpoint ` +
      `(model=${cp.model}, jobId=${cp.providerJobId})`,
    );
    try {
      videoUrl = await pollHyperealJob(cp.providerJobId, apiKey, cp.model, cp.pollUrl ?? null);
      provider = cp.model.includes("kling") ? "Kling V3.0 Pro I2V" : "Seedance 2.0 I2V";
    } catch (resumeErr) {
      // Resume failed — clear the stale checkpoint and fall through to a
      // fresh submit so the job isn't permanently wedged on a stuck poll.
      console.warn(
        `[CinematicVideo] Scene ${sceneIndex}: poll resume failed (${(resumeErr as Error).message}) — ` +
        `clearing checkpoint and re-submitting`,
      );
      await clearCheckpointKey(jobId, checkpointKey);
    }
  }

  // Per-scene try chain: try Seedance up to 2 times, then fall
  // back to Kling V3 Pro. Moderation rejection is permanent (held-frame
  // path below). Provider-credits exhaustion on Seedance jumps straight
  // to Kling — Kling is cheaper (39 cr vs 69), so it can succeed on a
  // balance that Seedance can't.
  try {
    const SEEDANCE_TRIES = 2;
    let lastSeedanceErr: Error | null = null;
    let seedanceCreditsExhausted = false;

    for (let attempt = 1; videoUrl === null && attempt <= SEEDANCE_TRIES; attempt++) {
      try {
        videoUrl = await generateSeedance2I2V(
          imageUrl,
          `${finalPrompt}\n\n${motionGuardrails}`,
          apiKey,
          10,             // duration: 10 seconds per scene
          endImageUrl,
          seedanceAspect, // aspect_ratio: derived from project format
          "720p",         // resolution
          false,          // enable_web_search: never for pre-scripted prompts
          // onSubmitted: persist provider jobId + pollUrl as a resume
          // checkpoint immediately after Hypereal returns. If the worker
          // dies during polling, the next worker reads this and skips
          // the re-submit.
          async ({ providerJobId, pollUrl, model }) => {
            await saveCheckpoint(jobId, checkpointKey, {
              stage: "polling", providerJobId, pollUrl, model,
            });
          },
        );
        break; // success — exit retry loop
      } catch (innerErr) {
        const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr);

        // Moderation rejection is permanent for that exact prompt — bubble
        // up to the outer catch so the held-frame path runs. Retrying just
        // resubmits the same prompt and burns another 61 credits (verified
        // 2026-05-08 incident: Sun-Sextile-Jupiter run lost ~14 jobs ×
        // 61 credits to this exact retry loop). The "potentially sensitive"
        // phrasing comes from Hypereal's Seedance 2.0 backend; the original
        // patterns ("risk control", "content violation", etc.) cover Kling
        // and earlier Seedance versions.
        if (/risk control|content[_ ]?violation|blocked.*content|moderation|potentially sensitive|flagged.*sensitive/i.test(innerMsg)) {
          throw innerErr;
        }

        lastSeedanceErr = innerErr instanceof Error ? innerErr : new Error(innerMsg);

        // Credits exhausted on Seedance? Don't waste the 2nd attempt —
        // jump straight to Kling (cheaper).
        if (innerMsg.startsWith("[PROVIDER_CREDITS_EXHAUSTED]")) {
          seedanceCreditsExhausted = true;
          console.warn(
            `[CinematicVideo] Scene ${sceneIndex}: Seedance credits exhausted on attempt ${attempt} — falling back to Kling V3.0 Pro`,
          );
          break;
        }

        console.warn(
          `[CinematicVideo] Scene ${sceneIndex}: Seedance attempt ${attempt}/${SEEDANCE_TRIES} failed: ${innerMsg.slice(0, 200)}`,
        );
      }
    }

    // Fallback to Kling V3 Pro if Seedance never produced a videoUrl.
    if (!videoUrl) {
      console.log(
        `[CinematicVideo] Scene ${sceneIndex}: falling back to Kling V3.0 Pro after Seedance failures` +
        `${seedanceCreditsExhausted ? " (credits exhausted on Seedance)" : ""}`,
      );
      await writeSystemLog({
        jobId, projectId, userId, generationId,
        category: "system_warning",
        eventType: "cinematic_video_kling_fallback",
        message: `Scene ${sceneIndex}: Seedance failed — falling back to Kling V3.0 Pro`,
        details: {
          sceneIndex,
          seedance_tries: SEEDANCE_TRIES,
          seedance_credits_exhausted: seedanceCreditsExhausted,
          last_seedance_error: (lastSeedanceErr?.message ?? "").slice(0, 240),
        },
      });

      try {
        videoUrl = await generateKlingV3ProI2V(
          imageUrl,
          finalPrompt,
          apiKey,
          10,                  // duration: 10s (Kling supports 3/5/10/15)
          endImageUrl,
          klingNegativePrompt,
          0.5,                 // cfg_scale
          async ({ providerJobId, pollUrl, model }) => {
            await saveCheckpoint(jobId, checkpointKey, {
              stage: "polling", providerJobId, pollUrl, model,
            });
          },
        );
        provider = "Kling V3.0 Pro I2V";
      } catch (klingErr) {
        // If Kling ALSO fails — surface the Kling error (more recent,
        // most actionable signal). The outer catch below classifies
        // PROVIDER_CREDITS_EXHAUSTED / moderation as before.
        throw klingErr;
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Provider credits exhausted on BOTH Seedance AND Kling — nothing
    // more we can do at the worker level. Bail with a distinct admin
    // log so ops sees it in the Errors tab and can refill the upstream
    // account. The dispatcher's normal fail path will refund the user's
    // MotionMax credits.
    if (errMsg.startsWith("[PROVIDER_CREDITS_EXHAUSTED]")) {
      await writeSystemLog({
        jobId, projectId, userId, generationId,
        category: "system_error",
        eventType: "provider_credits_exhausted",
        message: `Hypereal credits exhausted — scene ${sceneIndex} could not render on Seedance OR Kling V3 Pro`,
        details: { sceneIndex, provider: "seedance-2-0-i2v + kling-3-0-pro-i2v fallback", raw: errMsg.slice(0, 400) },
      });
      throw err;
    }

    // Treat moderation rejection as a permanent per-scene failure —
    // never retry and never bubble. Anything else (transient API,
    // timeout, etc.) we re-throw so the dispatcher's retry policy
    // gets a shot at it. Seedance + Kling surface moderation with
    // multiple wordings; the regex must cover ALL of them or the
    // held-frame fallback won't run. The "potentially sensitive" /
    // "flagged.*sensitive" patterns were added 2026-05-10 after a
    // Colombia/Group-K autopost run failed cleanly with that exact
    // wording but the outer catch (this regex) didn't recognise it
    // — it must match the same patterns the inner catch uses
    // (commit 2e377bb).
    const isModerationReject = /risk control|content[_ ]?violation|blocked.*content|moderation|potentially sensitive|flagged.*sensitive/i.test(errMsg);
    if (!isModerationReject) {
      throw err;
    }
    heldFrameReason = `Provider moderation rejected scene ${sceneIndex}; held still image as frame`;
    console.warn(`[CinematicVideo] Scene ${sceneIndex}: ${heldFrameReason} — ${errMsg}`);
    await writeSystemLog({
      jobId, projectId, userId, generationId,
      category: "system_warning",
      eventType: "cinematic_video_held_frame_fallback",
      message: `Scene ${sceneIndex}: provider moderation rejected — using still image as held frame`,
      details: {
        sceneIndex,
        provider: "seedance-2-0-i2v + kling-3-0-pro-i2v fallback",
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
        provider: "seedance-2-0-i2v + kling-3-0-pro-i2v fallback",
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

    // Held-frame is a terminal status — no resume needed.
    await clearCheckpointKey(jobId, checkpointKey);

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

  // Defensive: if we reach this point with no videoUrl, the catch
  // block above misclassified an error path. Should never trip in
  // practice but throwing here is safer than passing null into the
  // upload helper (which would mask the real bug).
  if (!videoUrl) {
    throw new Error(
      `[CinematicVideo] Scene ${sceneIndex}: reached upload step with null videoUrl — provider chain misclassified an error`,
    );
  }

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
      await clearCheckpointKey(jobId, checkpointKey);
      return { success: true, status: "stale_discarded", videoUrl: null, sceneIndex };
    }
  }

  // Cancellation check — Kling/Seedance video renders take 30-180s,
  // plenty of time for the user to hit Cancel in the Inspector. The
  // UI flips this row to status='failed' + error_message='Cancelled
  // by user' (the CHECK constraint on status doesn't include
  // 'cancelled', so we repurpose 'failed' and disambiguate via
  // error_message). By the time we get here Hypereal already did
  // the work and billed us (we accept that cost). What we MUST
  // avoid is the worse footgun: writing `videoUrl` onto
  // scenes[sceneIndex] AFTER the user gave up, overwriting whatever
  // they're editing now.
  {
    const { data: jobRow } = await supabase
      .from("video_generation_jobs")
      .select("status, error_message")
      .eq("id", jobId)
      .single();
    const wasCancelled = jobRow?.status === "failed" && jobRow?.error_message === "Cancelled by user";
    if (wasCancelled) {
      console.log(`[CinematicVideo] Job ${jobId.substring(0, 8)} was cancelled mid-flight — skipping scene write for scene ${sceneIndex}`);
      await writeSystemLog({
        jobId, projectId, userId, generationId,
        category: "system_info",
        eventType: "cinematic_video_cancelled",
        message: `Scene ${sceneIndex} video render cancelled by user — provider call completed but result discarded`,
        details: { sceneIndex, provider, hadVideo: !!finalVideoUrl },
      });
      await clearCheckpointKey(jobId, checkpointKey);
      return { success: false, status: "cancelled", videoUrl: null, sceneIndex };
    }
  }

  await updateSceneField(generationId, sceneIndex, "videoUrl", finalVideoUrl);
  // Scene's videoUrl is durably committed — drop the resume checkpoint
  // so a future re-claim of this row (manual retry, requeue) starts
  // fresh instead of resuming a stale provider jobId.
  await clearCheckpointKey(jobId, checkpointKey);

  await writeSystemLog({
    jobId, projectId, userId, generationId,
    category: "system_info",
    eventType: "cinematic_video_completed",
    message: `Cinematic video completed for scene ${sceneIndex} (${provider}, 10s${endImageUrl ? ", with transition" : ""})`,
    details: { provider, hasTransition: !!endImageUrl, cost: 0.40 },
  });

  await audit("video.gen_completed", {
    jobId, projectId, userId, generationId,
    message: `Cinematic video completed for scene ${sceneIndex}`,
    details: { sceneIndex, provider, hasTransition: !!endImageUrl, cost: 0.40 },
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
