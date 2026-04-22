/**
 * Finalize phase handler for the Node.js worker.
 * Mirrors handleFinalizePhase() from supabase/functions/generate-video/index.ts.
 * Marks the generation complete, records costs, cleans _meta from scenes.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";

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
  hyperealVideo: 0.10,            // Kling I2V via Hypereal
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

  // Fetch generation + project
  const { data: generation, error: genError } = await supabase
    .from("generations")
    .select("*, projects(title, length, project_type, voice_inclination)")
    .eq("id", generationId)
    .maybeSingle();

  if (genError || !generation) throw new Error(`Generation not found: ${genError?.message}`);

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
