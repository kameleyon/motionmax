/**
 * Finalize phase handler for the Node.js worker.
 * Mirrors handleFinalizePhase() from supabase/functions/generate-video/index.ts.
 * Marks the generation complete, records costs, cleans _meta from scenes.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";

// ── Pricing (matches edge function PRICING constants) ──────────────

const PRICING = {
  scriptPerToken: 0.000003,
  audioPerSecond: 0.002,
  imageNanoBanana: 0.04,
  imageNanoBananaPro: 0.04,
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
    .select("*, projects(title, length, project_type)")
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

  const totalTimeMs =
    (phaseTimings.script || 0) + (phaseTimings.audio || 0) +
    (phaseTimings.images || 0) + phaseTimings.finalize;

  // Strip _meta from final scene output
  const finalScenes = scenes.map((s: any) => {
    const { _meta, ...rest } = s;
    return rest;
  });

  // Record generation costs
  const scriptCost = costTracking.scriptTokens * PRICING.scriptPerToken;
  const audioCost = costTracking.audioSeconds * PRICING.audioPerSecond;
  const imageCost = costTracking.imagesGenerated * PRICING.imageNanoBanana;

  try {
    await supabase.from("generation_costs").insert({
      generation_id: generationId,
      user_id: userId || null,
      openrouter_cost: scriptCost,
      replicate_cost: imageCost + audioCost,
      hypereal_cost: 0,
      google_tts_cost: 0,
    });
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
