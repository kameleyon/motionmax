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
  generateSeedance2I2V,           // Hypereal Seedance 2.0 Fast — re-added 2026-05-18 as rung 4. Probe-verified (scripts/probe-hypereal-seedance-policy.mjs, 2026-05-18) to accept named soccer-player / World-Cup prompts that OpenRouter Seedance rejects with InputTextSensitiveContentDetected.PolicyViolation. ~141 cr/10s scene; cost-justified vs Kling because output style matches the rest of the Seedance chain.
  // generateKlingV3ProI2V,        // Newer variant — silently drops end_image. Replaced by V3ProVideo (older, simpler, end_image confirmed working at commit 38aeb4d).
  generateKlingV3ProVideo,        // Only fallback — Kling V3.0 Pro on Hypereal. Single `end_image` field, durations [5, 10] only.
  // generateGrokVideo,           // Grok Video I2V — status-lookup failures on Hypereal, rolled back
  pollHyperealJob,                // Resume-from-checkpoint poll for an already-submitted Hypereal job.
} from "../services/hypereal.js";
// AtlasCloud Seedance 2.0 — PRIMARY for cinematic video. Cheap when it
// works, 15-min poll cap covers tail latencies. Single fallback below
// is Hypereal Kling V3 Pro for any failure (moderation, timeout, etc.).
import { generateAtlasCloudSeedance } from "../services/atlasCloudSeedance.js";
import { generateOpenRouterVideo } from "../services/openrouterVideo.js";
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

  // Video generation routes to HYPEREAL_API_KEY (account A — the one
  // with billing balance). Reverted from HYPEREALIMAGE_API_KEY on
  // 2026-05-15 after the Seedance-Fast-on-account-B chain produced
  // 141-cr-per-attempt charges with high failure rate. Single account
  // now covers the only remaining Hypereal call site: Kling V3.0 Pro
  // as the AtlasCloud fallback.
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
    `[CinematicVideo] Scene ${sceneIndex}: starting 4-rung chain${regenerate ? " (regen)" : ""}, ` +
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
  // OpenRouter rungs return URLs that require a Bearer token to download.
  // We capture the header from the winning rung and pass it through to
  // uploadVideoToStorage. AtlasCloud / Hypereal URLs are publicly fetchable
  // — leave undefined for those rungs.
  let videoUrlAuthHeader: string | undefined;
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
  provider = "Replicate Seedance 2.0 Fast I2V";
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
    // Hypereal Seedance + Kling V3 Pro share a poll-URL shape, so a
    // single pollHyperealJob path covers both. Stale checkpoints from
    // OTHER providers — Replicate (`bytedance/seedance-2.0`,
    // `bytedance/seedance-2.0-fast`), AtlasCloud
    // (`bytedance/seedance-2.0/image-to-video`), or OpenRouter
    // (`bytedance/seedance-1-5-pro`, `kwaivgi/kling-video-o1`) — must
    // NOT be polled via Hypereal: the prediction IDs live on a
    // different host, returning 404 forever. Discard those checkpoints
    // and re-submit via the full provider chain below. Re-submit costs
    // one extra Seedance run (cheap) and is far better than wedging
    // the job for 45 min on a stuck poll. Verified 2026-05-15 when an
    // AtlasCloud checkpoint mis-routed to Hypereal produced 35 min of
    // 404 spam before manual intervention killed job 35ee8681.
    if (
      cp.model === "bytedance/seedance-2.0" ||
      cp.model === "bytedance/seedance-2.0-fast" ||
      cp.model === "bytedance/seedance-2.0/image-to-video" ||
      cp.model === "bytedance/seedance-1-5-pro" ||      // OpenRouter rung 1
      cp.model === "kwaivgi/kling-video-o1"             // OpenRouter rung 3
    ) {
      console.log(
        `[CinematicVideo] Scene ${sceneIndex}: cross-provider checkpoint (model=${cp.model}, pollUrl=${cp.pollUrl ?? "?"}) — clearing and re-submitting via primary chain`,
      );
      await clearCheckpointKey(jobId, checkpointKey);
    } else {
      console.log(
        `[CinematicVideo] Scene ${sceneIndex}: resuming Hypereal poll from checkpoint ` +
        `(model=${cp.model}, jobId=${cp.providerJobId})`,
      );
      try {
        videoUrl = await pollHyperealJob(cp.providerJobId, apiKey, cp.model, cp.pollUrl ?? null);
        provider = cp.model.includes("kling") ? "Kling V3.0 Pro I2V" : "Seedance 2.0 Fast I2V";
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
  }

  // OpenRouter rungs accept only 16:9 or 9:16. MotionMax's `seedanceAspect`
  // can be 1:1 for "square" projects, which the OpenRouter service's type
  // union rejects — collapse 1:1 → 16:9 for OR rungs only. AtlasCloud keeps
  // the full `seedanceAspect` value because it natively handles 1:1.
  const openRouterAspectRatio: "16:9" | "9:16" = seedanceAspect === "1:1" ? "16:9" : seedanceAspect;

  // Per-scene provider chain (4-rung as of 2026-05-16):
  //   1. OpenRouter Seedance 1.5 Pro @ 480p — cheapest 10s I2V on
  //      OpenRouter ($0.13/10s). New primary.
  //   2. AtlasCloud Seedance 2.0 @ 480p — fallback if OpenRouter fails.
  //      Was previous primary; demoted on 2026-05-16.
  //   3. OpenRouter Kling Video O1 @ 480p — third rung. Sits between
  //      AtlasCloud and Hypereal Kling. $1.12/10s flat.
  //   4. Hypereal Kling V3.0 Pro — terminal rung before held-frame.
  //      Different content classifier; sometimes accepts what
  //      Seedance/Kling-O1 refuse.
  //
  // Any non-moderation, non-credits-exhausted error cascades. Moderation
  // rejection only terminates the chain at rung 4 (held-frame).
  // [PROVIDER_CREDITS_EXHAUSTED] bubbles immediately at any rung.
  try {
    // The chain is ordered cheapest-first within each "policy family":
    //   • OpenRouter Seedance 1.5 Pro  ($0.26/10s)   — ByteDance copyright filter rejects named-IP prompts
    //   • OpenRouter Seedance 2.0 Fast ($1.20/10s)   — same upstream, SAME copyright filter (skip if rung 1 = copyright reject)
    //   • AtlasCloud Seedance 2.0      (~$0.30/10s)  — different account-level moderation, accepts named soccer / World Cup
    //   • Hypereal Seedance 2.0 Fast   (~$1.40/10s)  — probe-verified permissive on the same prompts (2026-05-18)
    //   • OpenRouter Kling Video O1    ($1.12/10s)   — different model family, different classifier
    //   • Hypereal Kling V3 Pro        (terminal)    — see rung 6 below
    //
    // Copyright fast-path: if rung 1 fails with InputTextSensitiveContent
    // Detected.PolicyViolation (or any string containing "copyright"),
    // skipping rung 2 saves one wasted submit because OpenRouter routes
    // both Seedance versions through the same ByteDance moderation
    // pipeline. Any other rung-1 error still tries rung 2 — the prompt
    // might be fine and the failure transient.
    let rung1CopyrightReject = false;

    // ── 1. OpenRouter Seedance 1.5 Pro @ 480p (PRIMARY) ──────────────
    // Cheapest rung. Any failure cascades down.
    {
      const orRes = await generateOpenRouterVideo({
        model: "bytedance/seedance-1-5-pro",
        imageUrl,
        endImageUrl,
        prompt: `${finalPrompt}\n\n${motionGuardrails}`,
        duration: 10,
        aspectRatio: openRouterAspectRatio,
        resolution: "480p",
        userId: userId ?? null,
        generationId,
        pollMaxMs: 4 * 60 * 1000,
        onSubmitted: async ({ providerJobId, pollUrl, model }) => {
          await saveCheckpoint(jobId, checkpointKey, {
            stage: "polling", providerJobId, pollUrl, model,
          });
        },
      });
      if (orRes.videoUrl) {
        videoUrl = orRes.videoUrl;
        videoUrlAuthHeader = orRes.downloadAuthHeader;
        provider = "OpenRouter Seedance 1.5 Pro @ 480p";
      } else {
        const err = orRes.error ?? "";
        rung1CopyrightReject = /InputTextSensitiveContentDetected|copyright/i.test(err);
        console.warn(
          `[CinematicVideo] Scene ${sceneIndex}: OpenRouter Seedance 1.5 Pro failed${rung1CopyrightReject ? " (copyright — skipping OR 2.0 Fast)" : ""}: ${err.slice(0, 200)}`,
        );
      }
    }

    // ── 2. OpenRouter Seedance 2.0 Fast @ 480p (FALLBACK 1) ──────────
    // Skipped when rung 1 rejected for copyright (same ByteDance filter
    // upstream). Otherwise tried because rung 1 may have hit a transient
    // OpenRouter / ByteDance error that 2.0 Fast won't.
    if (!videoUrl && !rung1CopyrightReject) {
      const orRes2 = await generateOpenRouterVideo({
        model: "bytedance/seedance-2.0-fast",
        imageUrl,
        endImageUrl,
        prompt: `${finalPrompt}\n\n${motionGuardrails}`,
        duration: 10,
        aspectRatio: openRouterAspectRatio,
        resolution: "480p",
        userId: userId ?? null,
        generationId,
        pollMaxMs: 4 * 60 * 1000,
        onSubmitted: async ({ providerJobId, pollUrl, model }) => {
          await saveCheckpoint(jobId, checkpointKey, {
            stage: "polling", providerJobId, pollUrl, model,
          });
        },
      });
      if (orRes2.videoUrl) {
        videoUrl = orRes2.videoUrl;
        videoUrlAuthHeader = orRes2.downloadAuthHeader;
        provider = "OpenRouter Seedance 2.0 Fast @ 480p";
      } else {
        console.warn(
          `[CinematicVideo] Scene ${sceneIndex}: OpenRouter Seedance 2.0 Fast failed — falling back to AtlasCloud: ${(orRes2.error ?? "").slice(0, 200)}`,
        );
      }
    }

    // ── 3. AtlasCloud Seedance 2.0 (FALLBACK 2) ──────────────────────
    // Cheap when funded. Different account-level moderation than
    // OpenRouter — accepts named soccer player / World Cup prompts that
    // ByteDance rejects via OpenRouter. Returns 402 when out of credits;
    // we cascade through to Hypereal in that case (the upstream balance
    // is an ops concern, not a worker-level decision).
    if (!videoUrl) {
      const atlasRes = await generateAtlasCloudSeedance({
        imageUrl,
        prompt: `${finalPrompt}\n\n${motionGuardrails}`,
        duration: 10,
        endImageUrl,
        aspectRatio: seedanceAspect,
        resolution: "480p",
        userId: userId ?? null,
        generationId,
        pollMaxMs: 4 * 60 * 1000,
        onSubmitted: async ({ providerJobId, pollUrl, model }) => {
          await saveCheckpoint(jobId, checkpointKey, {
            stage: "polling", providerJobId, pollUrl, model,
          });
        },
      });
      if (atlasRes.videoUrl) {
        videoUrl = atlasRes.videoUrl;
        provider = "AtlasCloud Seedance 2.0 @ 480p";
      } else {
        const msg = atlasRes.error ?? "(no error)";
        console.warn(
          `[CinematicVideo] Scene ${sceneIndex}: AtlasCloud Seedance failed — falling back to Hypereal Seedance: ${msg.slice(0, 200)}`,
        );
      }
    }

    // ── 4. Hypereal Seedance 2.0 Fast @ 480p (FALLBACK 3) ────────────
    // Re-added 2026-05-18 as the soccer/World-Cup-friendly catcher.
    // generateSeedance2I2V throws on failure (different contract than
    // the *Res-returning helpers above); wrap in try/catch so we can
    // (a) bubble [PROVIDER_CREDITS_EXHAUSTED] to the outer handler the
    // same way every other rung does, and (b) keep going to Kling on
    // any other error.
    if (!videoUrl) {
      try {
        const hyperealUrl = await generateSeedance2I2V(
          imageUrl,
          `${finalPrompt}\n\n${motionGuardrails}`,
          apiKey,
          10,
          endImageUrl,
          seedanceAspect,
          "480p",
          false,
          async ({ providerJobId, pollUrl, model }) => {
            await saveCheckpoint(jobId, checkpointKey, {
              stage: "polling", providerJobId, pollUrl, model,
            });
          },
        );
        videoUrl = hyperealUrl;
        provider = "Hypereal Seedance 2.0 Fast @ 480p";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("[PROVIDER_CREDITS_EXHAUSTED]")) throw err;
        console.warn(
          `[CinematicVideo] Scene ${sceneIndex}: Hypereal Seedance failed — falling back to OpenRouter Kling O1: ${msg.slice(0, 200)}`,
        );
      }
    }

    // ── 5. OpenRouter Kling Video O1 @ 480p (FALLBACK 4) ─────────────
    // Resolution-free pricing ($1.12 / 10s). Different content
    // classifier from Seedance, so may accept prompts the Seedance
    // rungs all refused.
    if (!videoUrl) {
      const orKlingRes = await generateOpenRouterVideo({
        model: "kwaivgi/kling-video-o1",
        imageUrl,
        endImageUrl,
        prompt: `${finalPrompt}\n\n${motionGuardrails}`,
        duration: 10,
        aspectRatio: openRouterAspectRatio,
        resolution: "480p",
        userId: userId ?? null,
        generationId,
        pollMaxMs: 4 * 60 * 1000,
        onSubmitted: async ({ providerJobId, pollUrl, model }) => {
          await saveCheckpoint(jobId, checkpointKey, {
            stage: "polling", providerJobId, pollUrl, model,
          });
        },
      });
      if (orKlingRes.videoUrl) {
        videoUrl = orKlingRes.videoUrl;
        videoUrlAuthHeader = orKlingRes.downloadAuthHeader;
        provider = "OpenRouter Kling Video O1 @ 480p";
      } else {
        console.warn(
          `[CinematicVideo] Scene ${sceneIndex}: OpenRouter Kling O1 failed — falling back to Hypereal Kling V3 Pro: ${(orKlingRes.error ?? "").slice(0, 200)}`,
        );
      }
    }

    // ── 6. Hypereal Kling V3.0 Pro (FALLBACK 5 / TERMINAL) ─────────
    // Catches whatever the Seedance rungs + OR Kling all rejected —
    // including E005/moderation refusals (Kling V3 Pro uses a different
    // classifier from O1) and provider hangs. Final layer before
    // held-frame; moderation rejection HERE is permanent and bubbles to
    // the outer catch.
    if (!videoUrl) {
      await writeSystemLog({
        jobId, projectId, userId, generationId,
        category: "system_warning",
        // eventType kept stable for log-search continuity even though
        // the chain has grown to 6 rungs; renaming would break Loki/
        // Sentry queries that watch for "cinematic_video_kling_fallback".
        eventType: "cinematic_video_kling_fallback",
        message: `Scene ${sceneIndex}: rungs 1-5 failed — falling back to Hypereal Kling V3 Pro (terminal rung)`,
        details: { sceneIndex },
      });

      // Using the older `generateKlingV3ProVideo` (simpler signature,
      // single `end_image` field, no onSubmitted checkpoint hook) —
      // restored from commit 38aeb4d after the newer V3ProI2V variant
      // was silently dropping end_image at Hypereal. Trade-off: a
      // worker restart mid-poll re-submits to Hypereal (extra credits)
      // because there's no checkpoint resume path here. Acceptable
      // because Kling V3 Pro polls finish in 2-3 min, well under our
      // 15-min hard timeout.
      videoUrl = await generateKlingV3ProVideo(
        imageUrl,
        finalPrompt,
        apiKey,
        10,                  // duration: must be 5 or 10 (clamped)
        endImageUrl,
        klingNegativePrompt,
        0.5,                 // cfg_scale
      );
      provider = "Kling V3.0 Pro Video";
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
        message: `Provider chain exhausted — scene ${sceneIndex} could not render on OR Seedance 1.5 Pro, OR Seedance 2.0 Fast, AtlasCloud, Hypereal Seedance, OR Kling O1, OR Hypereal Kling V3 Pro`,
        details: { sceneIndex, provider: "or-seedance-1-5-pro + or-seedance-2-0-fast + atlascloud + hypereal-seedance + or-kling-o1 + hypereal-kling-v3-pro chain", raw: errMsg.slice(0, 400) },
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
        provider: "or-seedance-1-5-pro + or-seedance-2-0-fast + atlascloud + hypereal-seedance + or-kling-o1 + hypereal-kling-v3-pro chain",
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
        provider: "or-seedance-1-5-pro + or-seedance-2-0-fast + atlascloud + hypereal-seedance + or-kling-o1 + hypereal-kling-v3-pro chain",
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
  let finalVideoUrl = await uploadVideoToStorage(videoUrl, projectId, generationId, sceneIndex, videoUrlAuthHeader);

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
  downloadAuthHeader?: string,
): Promise<string> {
  // OpenRouter video URLs (`unsigned_urls[0]`) require a Bearer token to
  // download — the calling rung passes its API key auth via
  // downloadAuthHeader. AtlasCloud / Hypereal URLs are publicly fetchable
  // and pass nothing here.
  const fetchOpts: RequestInit | undefined = downloadAuthHeader
    ? { headers: { Authorization: downloadAuthHeader } }
    : undefined;
  const res = await fetch(videoUrl, fetchOpts);
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
