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

// ── Pricing ──────────────────────────────────────────────────────
//
// C-8-8 fix: audio pricing is now indexed by ACTUAL provider per scene,
// not by a single "Qwen3PerSecond" sentinel. The voice_name on the
// project decides which TTS provider runs and therefore which rate
// applies — gm:* → Gemini Flash, sm:* → Smallest, custom → Fish Audio,
// English-male standard → LemonFox, etc. The old code billed Qwen3's
// $0.001/s for every scene regardless of the actual provider, so
// generation_costs disagreed with provider invoices on every single
// row (LemonFox is $0.08/1k chars; ElevenLabs is $0.18/1k chars;
// Fish Audio is $0.10/1k chars — none of these are seconds-billed).
//
// The constants below are kept in sync with worker/src/lib/providerRates.ts.
// Two surfaces because handleFinalize aggregates while providerRates
// computes per call — but the per-1k or per-second numbers must match.

const PRICING = {
  // Script generation (per token)
  openrouterPerToken: 0.000003,   // Claude Sonnet via OpenRouter
  hyperealLlmPerToken: 0.0000008, // Gemini via Hypereal ($0.80/M input)
  // Audio: per-provider rates (per 1k characters for char-billed
  // providers; per second for seconds-billed providers).
  geminiFlashTtsPerSecond: 0.001 / 60, // $0.001/min synthesized audio
  qwen3PerSecond: 0.001,          // Qwen3 TTS via Replicate (legacy / disabled)
  googleCloudTtsPerSecond: 0.004, // Google Cloud TTS for Haitian Creole
  fishAudioPer1kChars: 0.10,      // Fish Audio s2-pro
  lemonfoxPer1kChars: 0.08,       // LemonFox (Adam / River)
  elevenlabsPer1kChars: 0.18,     // ElevenLabs multilingual_v2
  smallestPer1kChars: 0.20,       // Smallest.ai lightning-v3.1
  // Images (per image)
  hyperealImage: 0.04,            // Hypereal image gen (base / gemini flash)
  hyperealGptImage2: 0.08,        // Hypereal gpt-image-2 premium
  replicateImage: 0.05,           // Replicate image gen (legacy)
  // Video (per 5s clip — Kling V2.6 Pro I2V via Hypereal)
  hyperealVideoPer5s: 0.20,
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

  // Record generation costs -- attribute to correct providers.
  //
  // C-8-7 / C-8-8: audio cost is now classified by the ACTUAL TTS
  // provider used per scene, not by a single Qwen3 rate. The voice_name
  // prefix decides:
  //   gm:*                  → Gemini Flash TTS (per second)
  //   sm: / sm2:*           → Smallest.ai      (per 1k chars)
  //   project.voice_type==='custom' → Fish Audio (per 1k chars)
  //   English-male standard → LemonFox        (per 1k chars)
  //   ht (Haitian Creole)   → Gemini Flash via the Creole branch
  //   else                  → Gemini Flash via the std router
  //
  // The new generation_costs columns added in migration
  // 20260510250100 receive the per-provider slice; the legacy
  // hypereal_cost / replicate_cost / google_tts_cost columns are
  // still written for dashboard back-compat (they alias the appropriate
  // new column).
  const projectType = (generation.projects as any)?.project_type || "doc2video";
  const isCinematic = projectType === "cinematic";
  const sceneCount = scenes.length;
  const voiceName: string = (generation.projects as any)?.voice_name || "";
  const voiceType: string = (generation.projects as any)?.voice_type || "standard";
  const voiceGenderRaw: string = (generation.projects as any)?.voice_gender || "";
  const language: string = (generation.projects as any)?.voice_inclination || "en";

  // Script: Hypereal (Gemini) primary, OpenRouter (Claude) fallback
  // We default to Hypereal since that's the primary now
  const scriptCost = costTracking.scriptTokens * PRICING.hyperealLlmPerToken;

  // Total spoken-text length across all scenes (used by char-billed providers).
  // For Smallest / Fish / LemonFox / ElevenLabs we bill by input chars; for
  // Gemini Flash and Google Cloud TTS we bill by output seconds.
  const totalChars: number = scenes.reduce(
    (sum: number, s: any) => sum + (typeof s?.voiceover === "string" ? s.voiceover.length : 0),
    0,
  ) || (sceneCount * 350); // fallback: ~350 chars/scene if voiceover field missing
  const audioSeconds: number = costTracking.audioSeconds || (sceneCount * 8); // ~8s/scene avg

  // Detect the per-project audio provider. The router (audioRouter.ts +
  // handleCinematicAudio.ts) takes the same first-match decisions; we
  // mirror them here. NOTE: scenes can each have a different audio
  // provider in theory, but every shipped flow today picks one provider
  // for the whole project — so we classify once.
  type AudioProviderKey = "gemini_flash" | "smallest" | "fish" | "lemonfox" | "elevenlabs" | "google_cloud" | "qwen3";
  // Declared with explicit type and `: AudioProviderKey` annotation so TS
  // keeps the union wide enough for the downstream switch — without the
  // annotation it narrows to just the literals assigned in the if-else
  // chain and the legacy-only `google_cloud` / `qwen3` arms become
  // unreachable per the type system (TS2678).
  const audioProviderKey: AudioProviderKey = ((): AudioProviderKey => {
    if (voiceType === "custom") return "fish";
    if (voiceName.startsWith("sm:") || voiceName.startsWith("sm2:")) return "smallest";
    if (voiceName.startsWith("gm:")) return "gemini_flash";
    if (voiceName.startsWith("el:")) return "elevenlabs";
    if (voiceName.startsWith("lf:") || (language === "en" && voiceGenderRaw === "male")) return "lemonfox";
    if (language === "ht") return "gemini_flash";
    return "gemini_flash";
  })();

  // Per-provider audio cost
  let fishAudioCost = 0;
  let lemonfoxCost = 0;
  let elevenlabsCost = 0;
  let smallestCost = 0;
  let geminiFlashTtsCost = 0;
  let googleCloudTtsCost = 0;
  let replicateAudioCost = 0;
  switch (audioProviderKey) {
    case "fish":
      fishAudioCost = (totalChars / 1000) * PRICING.fishAudioPer1kChars;
      break;
    case "lemonfox":
      lemonfoxCost = (totalChars / 1000) * PRICING.lemonfoxPer1kChars;
      break;
    case "elevenlabs":
      elevenlabsCost = (totalChars / 1000) * PRICING.elevenlabsPer1kChars;
      break;
    case "smallest":
      smallestCost = (totalChars / 1000) * PRICING.smallestPer1kChars;
      break;
    case "google_cloud":
      googleCloudTtsCost = audioSeconds * PRICING.googleCloudTtsPerSecond;
      break;
    case "qwen3":
      replicateAudioCost = audioSeconds * PRICING.qwen3PerSecond;
      break;
    case "gemini_flash":
    default:
      geminiFlashTtsCost = audioSeconds * PRICING.geminiFlashTtsPerSecond;
      break;
  }

  // Images: Hypereal for cinematic, mix for others
  const imageCount = costTracking.imagesGenerated || sceneCount;
  // We default to gpt-image-2 (premium) as the primary chain since
  // imageGenerator.ts tries it first. Fallbacks are gemini-flash-image
  // and OpenRouter; treating each scene as gpt-image-2 priced is the
  // closest single-rate approximation absent per-call detail in the
  // costTracking blob.
  const imageCost = imageCount * PRICING.hyperealGptImage2;

  // Video: Kling I2V via Hypereal — billed in 5s blocks.
  const videoCost = isCinematic ? sceneCount * PRICING.hyperealVideoPer5s : 0;

  // Research: ~1 Gemini call for cinematic/storytelling (priced as
  // Hypereal LLM tokens).
  const researchCost = (isCinematic || projectType === "storytelling") ? 0.005 : 0;

  // ASR: ~1 credit per scene for caption transcription (cinematic only)
  const asrCost = isCinematic ? (sceneCount * (8 / 60) * PRICING.hyperealAsr) : 0;

  // Aggregate by column. Legacy three-column rollup is preserved:
  //   - hypereal_cost  ← image, video, research, ASR, script
  //   - replicate_cost ← Qwen3 audio (only when actually used)
  //   - google_tts_cost ← Gemini-Flash + Google Cloud TTS combined
  // New per-provider columns (added in migration 20260510250100) carry
  // the granular breakdown for dashboards.
  const hyperealTotal = scriptCost + imageCost + videoCost + researchCost;
  const replicateTotal = replicateAudioCost;
  const openrouterTotal = 0; // Only used as fallback now
  const googleTtsLegacyTotal = geminiFlashTtsCost + googleCloudTtsCost;

  try {
    await supabase.from("generation_costs").insert({
      generation_id: generationId,
      user_id: userId || null,
      // Legacy columns (kept for dashboard back-compat)
      openrouter_cost: openrouterTotal,
      replicate_cost: replicateTotal,
      hypereal_cost: hyperealTotal,
      google_tts_cost: googleTtsLegacyTotal,
      // New per-provider columns (C-8-7)
      fish_audio_cost: fishAudioCost,
      elevenlabs_cost: elevenlabsCost,
      lemonfox_cost: lemonfoxCost,
      smallest_cost: smallestCost,
      gemini_flash_tts_cost: geminiFlashTtsCost,
      hypereal_asr_cost: asrCost,
      hypereal_video_cost: videoCost,
      // openai_cost stays 0 here — we route through OpenRouter + Hypereal,
      // not direct OpenAI. Reserved for future direct-OpenAI flows.
    });
    console.log(
      `[Finalize] Costs recorded: provider=${audioProviderKey} chars=${totalChars} secs=${audioSeconds} ` +
      `hypereal=$${hyperealTotal.toFixed(4)} audio=$${(fishAudioCost + lemonfoxCost + elevenlabsCost + smallestCost + geminiFlashTtsCost + googleCloudTtsCost + replicateAudioCost).toFixed(4)} ` +
      `(${sceneCount} scenes, ${projectType})`
    );
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

  // Compute total video duration (NOT wall-clock generation time) for
  // the dashboard stats strip. Prefer the master-audio probe (set by
  // handleMasterAudio for doc2video/cinematic). For legacy or single-
  // scene paths without a master track, sum each scene's _meta.audio
  // DurationMs (set by master-audio slicing or per-scene TTS). Skip
  // stamping if both are zero so the column stays NULL rather than
  // recording a misleading 0.
  const masterDurationMs = (generation as { master_audio_duration_ms?: number | null }).master_audio_duration_ms;
  const scenesDurationMs = scenes.reduce(
    (sum: number, s: any) => sum + ((s?._meta?.audioDurationMs as number) || 0),
    0,
  );
  const totalDurationMs = (typeof masterDurationMs === "number" && masterDurationMs > 0)
    ? masterDurationMs
    : (scenesDurationMs > 0 ? scenesDurationMs : null);

  // Mark generation complete
  await supabase
    .from("generations")
    .update({
      status: "complete",
      progress: 100,
      completed_at: new Date().toISOString(),
      scenes: finalScenesWithMeta,
      ...(totalDurationMs !== null ? { total_duration_ms: totalDurationMs } : {}),
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
