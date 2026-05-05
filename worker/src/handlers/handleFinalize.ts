/**
 * Finalize phase handler for the Node.js worker.
 * Mirrors handleFinalizePhase() from supabase/functions/generate-video/index.ts.
 * Marks the generation complete, records costs, cleans _meta from scenes.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { audit, auditError } from "../lib/audit.js";
import { generateLyriaMusic, lyriaIsConfigured, type LyriaMusicGenre } from "../services/lyriaMusic.js";
import { retryDbRead } from "../lib/retryClassifier.js";

// ── Pricing (matches edge function PRICING constants) ──────────────

const PRICING = {
  // Script generation (per token)
  openrouterPerToken: 0.000003,   // Claude Sonnet via OpenRouter
  hyperealLlmPerToken: 0.0000008, // Gemini via Hypereal ($0.80/M input)
  // Audio (per second)
  qwen3PerSecond: 0.001,          // Qwen3 TTS via Replicate
  elevenlabsPerSecond: 0.003,     // ElevenLabs TTS
  googleTtsPerSecond: 0.004,      // Google Cloud TTS
  fishAudioPerSecond: 0.001,      // Fish Audio
  lemonfoxPerSecond: 0.001,       // LemonFox
  // Images (per image)
  hyperealImage: 0.04,            // Hypereal image gen
  replicateImage: 0.05,           // Replicate image gen
  // Video (per 10s clip)
  hyperealVideo: 0.70,            // Kling V2.6 Pro I2V via Hypereal (10s, no sound)
  // ASR (per minute)
  hyperealAsr: 0.01,              // Hypereal audio-asr
};

// ── Types ──────────────────────────────────────────────────────────

interface FinalizePayload {
  generationId: string;
  projectId: string;
  [key: string]: unknown;
}

interface FinalizeResult {
  success: boolean;
  title: string;
  sceneCount: number;
  scenes: any[];
  costTracking?: any;
  phaseTimings?: any;
  totalTimeMs?: number;
  phaseTime: number;
}

// ── Handler ────────────────────────────────────────────────────────

export async function handleFinalizePhase(
  jobId: string,
  payload: FinalizePayload,
  userId?: string,
): Promise<FinalizeResult> {
  const { generationId, projectId } = payload;

  try {
    return await _runFinalize(jobId, payload, userId);
  } catch (err) {
    await auditError("gen.failed", err, {
      jobId, projectId, userId, generationId,
      details: { phase: "finalize" },
    });
    throw err;
  }
}

async function _runFinalize(
  jobId: string,
  payload: FinalizePayload,
  userId?: string,
): Promise<FinalizeResult> {
  const phaseStart = Date.now();
  const { generationId, projectId } = payload;

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "finalize_phase_started",
    message: `Finalize phase started`,
  });

  // Fetch generation + project. We keep the nested project select
  // limited to columns that are guaranteed to exist on every deploy so
  // old DB schemas (where `intake_settings` hasn't been migrated yet)
  // don't break finalize. The optional `intake_settings` / `content`
  // columns are fetched in a separate, defensive query below.
  const { data: generation, error: genError } = await retryDbRead(() =>
    supabase
      .from("generations")
      .select("*, projects(title, length, project_type, voice_inclination)")
      .eq("id", generationId)
      .maybeSingle()
  );

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

  // Try to load the new intake settings + prompt content. Any failure
  // (missing column on older DB, RLS quirk, etc.) must NOT fail the
  // whole generation — we just skip music / lipsync wiring and let the
  // render complete.
  let intakeSettings: Record<string, unknown> | null = null;
  let projectContent: string | null = null;
  try {
    const { data: proj } = await supabase
      .from("projects")
      .select("intake_settings, content")
      .eq("id", projectId)
      .maybeSingle();
    if (proj) {
      intakeSettings = (proj as { intake_settings?: Record<string, unknown> }).intake_settings ?? null;
      projectContent = (proj as { content?: string }).content ?? null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Finalize] intake_settings lookup skipped: ${msg}`);
    // Column doesn't exist — fall back to content-only fetch so we can
    // still recover settings from the IntakeForm's content-suffix fallback.
    try {
      const { data: proj } = await supabase
        .from("projects")
        .select("content")
        .eq("id", projectId)
        .maybeSingle();
      if (proj) projectContent = (proj as { content?: string }).content ?? null;
    } catch { /* ignore */ }
  }

  // Recover intake settings from the content-suffix fallback
  // (IntakeForm stores them there when projects.intake_settings column
  // is missing). Sentinel: `<!--INTAKE_SETTINGS:{json}:END-->`. We also
  // strip the suffix from projectContent so it doesn't leak into the
  // Lyria music prompt or any downstream LLM call.
  if (!intakeSettings && projectContent) {
    const match = projectContent.match(/<!--INTAKE_SETTINGS:(.*?):END-->/s);
    if (match && match[1]) {
      try {
        intakeSettings = JSON.parse(match[1]) as Record<string, unknown>;
        projectContent = projectContent.replace(match[0], "").trim();
        console.log(`[Finalize] Recovered intake_settings from content suffix`);
      } catch (err) {
        console.warn(`[Finalize] Intake suffix parse failed: ${(err as Error).message}`);
      }
    }
  }

  const scenes: any[] = generation.scenes || [];
  const meta = scenes[0]?._meta || {};
  const costTracking = meta.costTracking || {
    scriptTokens: 0,
    audioSeconds: 0,
    imagesGenerated: 0,
    estimatedCostUsd: 0,
  };
  const phaseTimings = meta.phaseTimings || {};
  phaseTimings.finalize = Date.now() - phaseStart;

  // Accurate wall-clock generation time — from when the script worker
  // picked up the job (generation.started_at) to RIGHT NOW (just before
  // we mark the row complete below). Previously we summed per-phase
  // timings which undercounted parallel work + queue waits. The user
  // specifically asked for start-of-pickup → 100%-complete accuracy.
  //
  // `generation.started_at` is stamped by generateVideo.ts at the same
  // moment the generation row is inserted, which is ~100ms after the
  // worker claims the generate_video job. Close enough to "pickup".
  const startedAtMs = generation.started_at
    ? new Date(generation.started_at).getTime()
    : null;
  const totalTimeMs = startedAtMs
    ? Date.now() - startedAtMs
    // Fallback (should never hit): sum phase timings if started_at is
    // missing on a legacy row.
    : (phaseTimings.script || 0) + (phaseTimings.audio || 0) +
      (phaseTimings.images || 0) + phaseTimings.finalize;

  // Also store a structured generation_duration_sec so dashboards /
  // analytics can read it without parsing _meta.
  const totalTimeSec = Math.max(0, Math.round(totalTimeMs / 1000));
  phaseTimings.totalWallClockMs = totalTimeMs;

  // Strip _meta from final scene output
  const finalScenes = scenes.map((s: any) => {
    const { _meta, ...rest } = s;
    return rest;
  });

  // Record generation costs -- attribute to correct providers
  const projectType = (generation.projects as any)?.project_type || "doc2video";
  const isCinematic = projectType === "cinematic";
  const sceneCount = scenes.length;

  // Script: Hypereal (Gemini) primary, OpenRouter (Claude) fallback
  // We default to Hypereal since that's the primary now
  const scriptCost = costTracking.scriptTokens * PRICING.hyperealLlmPerToken;

  // Audio: pricing differs by provider. Haitian Creole uses Google TTS; all others use Qwen3.
  const audioSeconds = costTracking.audioSeconds || (sceneCount * 8); // ~8s per scene avg
  const language = (generation.projects as any)?.voice_inclination || "en";
  const audioRatePerSec = language === "ht" ? PRICING.googleTtsPerSecond : PRICING.qwen3PerSecond;
  const audioCost = audioSeconds * audioRatePerSec;

  // Images: Hypereal for cinematic, mix for others
  const imageCount = costTracking.imagesGenerated || sceneCount;
  const imageCost = imageCount * PRICING.hyperealImage;

  // Video: Kling I2V for cinematic only
  const videoCost = isCinematic ? sceneCount * PRICING.hyperealVideo : 0;

  // Research: ~1 Hypereal Gemini call for cinematic/storytelling
  const researchCost = (isCinematic || projectType === "storytelling") ? 0.005 : 0;

  // ASR: ~1 credit per scene for caption transcription (cinematic only)
  const asrCost = isCinematic ? (sceneCount * (8 / 60) * PRICING.hyperealAsr) : 0;

  // Attribution: most costs go to Hypereal now (images, video, LLM, ASR)
  const hyperealTotal = scriptCost + imageCost + videoCost + researchCost + asrCost;
  const replicateTotal = language !== "ht" ? audioCost : 0; // Qwen3 TTS on Replicate (non-HC)
  const openrouterTotal = 0; // Only used as fallback now
  const googleTtsTotal = language === "ht" ? audioCost : 0; // Google TTS for Haitian Creole

  try {
    await supabase.from("generation_costs").insert({
      generation_id: generationId,
      user_id: userId || null,
      openrouter_cost: openrouterTotal,
      replicate_cost: replicateTotal,
      hypereal_cost: hyperealTotal,
      google_tts_cost: googleTtsTotal,
    });
    console.log(`[Finalize] Costs recorded: hypereal=$${hyperealTotal.toFixed(4)} replicate=$${replicateTotal.toFixed(4)} (${sceneCount} scenes, ${projectType})`);
  } catch (err) {
    console.warn("[Finalize] Cost recording failed (non-fatal):", err);
  }

  // Re-add _meta to final scenes for the UI
  const finalScenesWithMeta = finalScenes.map((s: any, idx: number) => ({
    ...s,
    _meta: {
      statusMessage: "Generation complete!",
      costTracking,
      phaseTimings,
      totalTimeMs,
      lastUpdate: new Date().toISOString(),
    },
  }));

  // Mark generation complete
  await supabase
    .from("generations")
    .update({
      status: "complete",
      progress: 100,
      completed_at: new Date().toISOString(),
      scenes: finalScenesWithMeta,
    })
    .eq("id", generationId);

  // Extract thumbnail from first scene with an image (check imageUrl and imageUrls)
  let thumbnailUrl: string | null = null;
  for (const s of finalScenes as any[]) {
    if (s.imageUrl) { thumbnailUrl = s.imageUrl; break; }
    if (Array.isArray(s.imageUrls) && s.imageUrls.length > 0 && s.imageUrls[0]) { thumbnailUrl = s.imageUrls[0]; break; }
  }

  // Mark project complete and write thumbnail
  await supabase
    .from("projects")
    .update({
      status: "complete",
      ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
    })
    .eq("id", projectId);

  if (thumbnailUrl) {
    console.log(`[Finalize] Thumbnail set for project ${projectId}: ${thumbnailUrl.substring(0, 80)}...`);
  }

  // NOTE: Do NOT clean up scene-images / scene-videos here. Users still need
  // them to (1) preview the generation in the UI and (2) export the MP4 later.
  // Cleanup belongs in the export handler, and only after export succeeds.

  // ── Music generation (Lyria 3 Pro via Hypereal) ──────────────────
  // The user opts in via the new IntakeForm's Music & SFX toggle. The
  // intake blob's shape is `{ music: { on, genre, intensity, sfx, uploadUrl? } }`.
  // Music generation is ADDITIVE — failures must NOT fail the whole
  // generation, because the scenes + audio are already rendered. We log
  // and continue. The exportVideo handler (later, when the user hits
  // "Export") picks up `scenes[0]._meta.musicUrl` if present and mixes
  // it under the narration via ffmpeg.
  //
  // PER-SCENE MUTE TOGGLES: The editor surfaces per-scene
  // `_meta.muteMusic` and `_meta.muteSfx` switches in the Inspector's
  // Scene tab. When the export's mix step is implemented it MUST
  // check these flags per-scene and skip stem mixing for any scene
  // where the corresponding flag is true. Today the export concat
  // doesn't mix music yet, so the toggles are forward-compat — but
  // the data is there in scene._meta and editor reads/writes it.
  // ── Music + SFX TEMPORARILY DISABLED ──
  // Lyria generation is not reliable yet on either Hypereal or
  // Google direct; both surfaces have produced empty/invalid audio
  // responses. Forcing the entire block off until the provider
  // situation is resolved. The intake form ALSO forces music.on=false
  // so even if a stale intake row has music enabled, this guard
  // catches it. Re-enable by setting MUSIC_SFX_DISABLED = false.
  const MUSIC_SFX_DISABLED = true;
  try {
    const intake = intakeSettings as
      | { music?: { on?: boolean; genre?: string; intensity?: number; sfx?: boolean } }
      | null;
    const music = intake?.music;
    const apiKey = (process.env.HYPEREAL_API_KEY || "").trim();
    void apiKey;

    // ── Music bed (Lyria 3 Pro) ──
    if (!MUSIC_SFX_DISABLED && music?.on && lyriaIsConfigured()) {
      const approxDurationSec = Math.min(120, Math.max(20, finalScenes.length * 10));
      console.log(`[Finalize] Music on — calling Lyria 3 Pro for ~${approxDurationSec}s track`);
      const musicUrl = await generateLyriaMusic({
        prompt: projectContent ?? "",
        durationSec: approxDurationSec,
        apiKey,
        genre: music.genre as LyriaMusicGenre | undefined,
        intensity: music.intensity,
        projectId,
        label: "music",
      });

      const augmented = finalScenesWithMeta.map((s: any, i: number) =>
        i === 0
          ? { ...s, _meta: { ...(s._meta || {}), musicUrl, musicGenre: music.genre, musicIntensity: music.intensity } }
          : s,
      );
      await supabase
        .from("generations")
        .update({ scenes: augmented, music_url: musicUrl })
        .eq("id", generationId);
      console.log(`[Finalize] Music URL persisted to generations.music_url: ${musicUrl.slice(0, 80)}`);
    }

    // ── SFX bed (Lyria 3 Pro with ambient/foley prompt) ──
    try {
      if (!MUSIC_SFX_DISABLED && music?.sfx && lyriaIsConfigured()) {
        const sfxDurationSec = Math.min(120, Math.max(20, finalScenes.length * 10));
        const sfxPrompt = [
          "Ambient atmospheric bed, subtle room tone and environmental foley.",
          "No melody, no vocals, no drums, no percussion.",
          "Low, diffuse, cinematic texture that fills the space without competing.",
          projectContent?.trim() ? `Context: ${projectContent.trim().slice(0, 300)}` : "",
        ].filter(Boolean).join(" ");

        console.log(`[Finalize] SFX on — calling Lyria 3 Pro for ~${sfxDurationSec}s ambient bed`);
        const sfxUrl = await generateLyriaMusic({
          prompt: sfxPrompt,
          durationSec: sfxDurationSec,
          apiKey,
          intensity: 15,
          projectId,
          label: "sfx",
        });
        await supabase
          .from("generations")
          .update({ sfx_url: sfxUrl })
          .eq("id", generationId);
        console.log(`[Finalize] SFX URL persisted to generations.sfx_url: ${sfxUrl.slice(0, 80)}`);
      }
    } catch (sfxErr) {
      const msg = sfxErr instanceof Error ? sfxErr.message : String(sfxErr);
      console.warn(`[Finalize] SFX bed skipped: ${msg}`);
      await writeSystemLog({
        jobId, projectId, userId, generationId,
        category: "system_warning",
        eventType: "finalize_sfx_skipped",
        message: `Lyria SFX bed failed or skipped: ${msg}`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Finalize] Music generation skipped: ${msg}`);
    await writeSystemLog({
      jobId, projectId, userId, generationId,
      category: "system_warning",
      eventType: "finalize_music_skipped",
      message: `Lyria music generation failed or skipped: ${msg}`,
    });
  }

  const phaseTime = Date.now() - phaseStart;

  await writeSystemLog({
    jobId,
    projectId,
    userId,
    generationId,
    category: "system_info",
    eventType: "finalize_phase_completed",
    message: `Generation finalized: ${finalScenes.length} scenes, ${Math.round(totalTimeMs / 1000)}s total`,
    details: { costTracking, phaseTimings, totalTimeMs },
  });

  await audit("gen.completed", {
    jobId, projectId, userId, generationId,
    message: `Generation finalized: ${finalScenes.length} scenes, ${Math.round(totalTimeMs / 1000)}s total`,
    details: { sceneCount: finalScenes.length, totalTimeMs, costTracking, phaseTimings },
  });

  return {
    success: true,
    title: generation.projects?.title || "Untitled",
    sceneCount: finalScenes.length,
    scenes: finalScenesWithMeta,
    costTracking,
    phaseTimings,
    totalTimeMs,
    phaseTime,
  };
}
