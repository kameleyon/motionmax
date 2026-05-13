/**
 * lipsync-enqueue — POST endpoint to start a post-generation lipsync run.
 *
 * Request:
 *   { generationId: string, model?: 'lipsync-2' | 'lipsync-2-pro' }
 *
 * Effects (atomic, in order):
 *   1. Verify caller owns the generation row.
 *   2. Ensure master_audio_url is present (no audio → no lipsync).
 *   3. Resolve the source video URL = the latest successful export_video
 *      job's result.finalUrl for this generation.
 *   4. Reject if a lipsync job is already queued/processing.
 *   5. Compute credit cost from master_audio_duration_ms + model tier.
 *      Default rate: 2 credits/sec (lipsync-2), 5 credits/sec (lipsync-2-pro).
 *   6. Deduct credits via deduct_credits_securely RPC.
 *   7. Insert a `lipsync_finalize` job. On insert failure, refund.
 *   8. Mark generations.lipsync_status='queued'.
 *
 * Response:
 *   { success: true, jobId, creditsDeducted, model }
 *   or 4xx { error } with no DB mutations on the failure paths above.
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { deductCredits, refundCredits } from "../_shared/credits.ts";

type LipsyncModel = "lipsync-2" | "lipsync-2-pro";

interface EnqueueRequest {
  generationId: string;
  model?: LipsyncModel;
}

interface EnqueueResponse {
  success: true;
  jobId: string;
  creditsDeducted: number;
  model: LipsyncModel;
}

// sync.so prices per output-second: $0.06 (lipsync-2) or $0.15 (lipsync-2-pro).
// With 1 credit ≈ $0.01 and ~30% margin → 2 cr/s standard, 5 cr/s pro.
const CREDITS_PER_SECOND: Record<LipsyncModel, number> = {
  "lipsync-2": 2,
  "lipsync-2-pro": 5,
};

function jsonResponse(corsHeaders: Record<string, string>, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  if (req.method !== "POST") {
    return jsonResponse(corsHeaders, { error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return jsonResponse(corsHeaders, { error: "Supabase env missing" }, 500);
    }

    // User-scoped client to read the auth user from the JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(supabaseUrl, serviceKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return jsonResponse(corsHeaders, { error: "Unauthorized" }, 401);
    }

    // Service-role client for the mutations below — RLS would block the
    // service write to video_generation_jobs without it.
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = (await req.json().catch(() => null)) as EnqueueRequest | null;
    if (!body?.generationId) {
      return jsonResponse(corsHeaders, { error: "generationId is required" }, 400);
    }
    const model: LipsyncModel = body.model === "lipsync-2-pro" ? "lipsync-2-pro" : "lipsync-2";

    // 1. Ownership + audio + duration
    const { data: gen, error: genErr } = await supabase
      .from("generations")
      .select("id, user_id, master_audio_url, master_audio_duration_ms, lipsync_status, project_id")
      .eq("id", body.generationId)
      .maybeSingle();
    if (genErr || !gen) {
      return jsonResponse(corsHeaders, { error: "Generation not found" }, 404);
    }
    if (gen.user_id !== user.id) {
      return jsonResponse(corsHeaders, { error: "Forbidden" }, 403);
    }
    if (!gen.master_audio_url) {
      return jsonResponse(corsHeaders, { error: "Generation has no master audio — lipsync requires audio" }, 400);
    }
    if (!gen.master_audio_duration_ms || gen.master_audio_duration_ms <= 0) {
      return jsonResponse(corsHeaders, { error: "Generation has no audio duration — cannot price lipsync" }, 400);
    }

    // sync.so handles clips up to ~10 minutes. No hard pre-flight needed
    // here beyond presence checks above — let the model itself surface
    // any unusual edge cases via the worker's failed-status writeback.

    // 2. Already in flight?
    if (gen.lipsync_status === "queued" || gen.lipsync_status === "processing") {
      return jsonResponse(corsHeaders, { error: "Lipsync is already running for this generation" }, 409);
    }

    // 3. Source video = latest successful export's finalUrl. The
    //    export_video job's payload carries `project_id`, NOT
    //    `generationId` (that's only set internally for cost
    //    attribution, never written back to the row). So we look up
    //    by project_id from the generation row. handleExportVideo
    //    writes finalUrl onto both `result` (newer schema) and
    //    sometimes `payload` (legacy merge) — read either.
    const { data: exportJob, error: expErr } = await supabase
      .from("video_generation_jobs")
      .select("id, payload, result")
      .eq("user_id", user.id)
      .eq("task_type", "export_video")
      .eq("status", "completed")
      .contains("payload", { project_id: gen.project_id })
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (expErr) {
      return jsonResponse(corsHeaders, { error: `Could not look up export job: ${expErr.message}` }, 500);
    }
    const sourceVideoUrl =
      (exportJob?.result as { finalUrl?: string } | null)?.finalUrl ??
      (exportJob?.payload as { finalUrl?: string } | null)?.finalUrl ??
      null;
    if (!sourceVideoUrl) {
      return jsonResponse(corsHeaders, { error: "No exported video found — export the project first" }, 400);
    }

    // 4. Price = ceil(durationSeconds × CREDITS_PER_SECOND[model]).
    const durationSec = gen.master_audio_duration_ms / 1000;
    const credits = Math.ceil(durationSec * CREDITS_PER_SECOND[model]);
    if (credits <= 0) {
      return jsonResponse(corsHeaders, { error: "Could not compute credit cost" }, 500);
    }

    // 5. Deduct credits (atomic — RPC checks balance + decrements in one tx).
    const deductResult = await deductCredits(
      supabase,
      user.id,
      credits,
      `Lipsync (${model}) for generation ${body.generationId}`,
    );
    if (!deductResult.success) {
      return jsonResponse(corsHeaders, { error: deductResult.error ?? "Insufficient credits", upgrade: true }, 402);
    }

    // 6. Insert the job. On failure, refund.
    const { data: job, error: jobErr } = await supabase
      .from("video_generation_jobs")
      .insert({
        user_id: user.id,
        task_type: "lipsync_finalize",
        status: "pending",
        project_id: gen.project_id ?? null,
        payload: {
          generationId: body.generationId,
          sourceVideoUrl,
          audioUrl: gen.master_audio_url,
          model,
          creditsDeducted: credits,
          // Trace id for end-to-end correlation in Sentry/PostHog.
          traceId: crypto.randomUUID(),
        },
      })
      .select("id")
      .single();
    if (jobErr || !job) {
      await refundCredits(supabase, user.id, credits, "Refund: lipsync job insert failed");
      return jsonResponse(corsHeaders, { error: jobErr?.message ?? "Failed to queue lipsync job" }, 500);
    }

    // 7. Stamp the generation row.
    await supabase
      .from("generations")
      .update({
        lipsync_status: "queued",
        lipsync_credits_charged: credits,
        lipsync_model: model,
        lipsync_provider: "sync_labs",
        lipsync_error: null,
      })
      .eq("id", body.generationId);

    const response: EnqueueResponse = {
      success: true,
      jobId: job.id,
      creditsDeducted: credits,
      model,
    };
    return jsonResponse(corsHeaders, response);
  } catch (err) {
    console.error("[lipsync-enqueue] Unhandled exception:", err);
    return jsonResponse(corsHeaders, { error: (err as Error).message ?? "Internal error" }, 500);
  }
});
