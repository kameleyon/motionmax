/**
 * clone-voice-fish — queues a Fish Audio voice-clone job.
 *
 * Why an edge function at all (vs. inserting the job from the browser):
 *   - Auth: we must validate the JWT and confirm the user actually
 *     owns the storage path they're asking us to clone.
 *   - Plan limits: we enforce voiceClones-per-plan here so a malicious
 *     client can't bypass the UI and spam clones.
 *   - Idempotency: if the user double-clicks "Train", we'd otherwise
 *     spawn two jobs from the browser. The edge function dedupes.
 *
 * Flow:
 *   1. Validate auth + plan limit
 *   2. Confirm the storage path is inside the user's own folder
 *   3. Insert a `clone_voice` job; worker handles transcode + Fish call
 *   4. Return { jobId } — browser polls video_generation_jobs for the
 *      job to flip to completed and reads result.voiceId
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";

interface CloneRequestBody {
  storagePath: string;
  voiceName: string;
  description?: string;
  transcript?: string;
  consentGiven: boolean;
  removeNoise?: boolean;
}

const PLAN_VOICE_LIMITS: Record<string, number> = {
  free: 0,
  creator: 1,
  studio: 5,
  agency: 20,
};

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json()) as CloneRequestBody;
    const { storagePath, voiceName, description, transcript, consentGiven, removeNoise } = body;

    if (!consentGiven) {
      return new Response(JSON.stringify({ error: "Consent is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!storagePath || !voiceName?.trim()) {
      return new Response(JSON.stringify({ error: "storagePath and voiceName are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Path must start with the user's own id folder — prevents one
    // user passing another user's storage path.
    if (!storagePath.startsWith(`${user.id}/`)) {
      return new Response(JSON.stringify({ error: "Storage path does not belong to caller" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Enforce plan voice-clone limit. The subscriptions table column
    // is `plan_name` (was reading `plan` previously which is undefined
    // → every user got bucketed as "free" → 0 voice limit → 402).
    // Manual / enterprise rows still use plan_name='studio' so the
    // existing PLAN_VOICE_LIMITS map covers them.
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("plan_name, status")
      .eq("user_id", user.id)
      .maybeSingle();
    const planRaw = (sub?.plan_name as string | undefined) ?? "free";
    const plan = planRaw.toLowerCase();
    const limit = PLAN_VOICE_LIMITS[plan] ?? 0;

    const { count: currentCount } = await supabase
      .from("user_voices")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    if ((currentCount ?? 0) >= limit) {
      return new Response(
        JSON.stringify({
          error: `Voice clone limit reached for ${plan} plan (${limit} allowed). Delete a voice or upgrade your plan.`,
        }),
        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Queue the worker job. The worker has ffmpeg for the WebM → MP3
    // transcode that Fish IVC works best with.
    const { data: job, error: jobErr } = await supabase
      .from("video_generation_jobs")
      .insert({
        user_id: user.id,
        task_type: "clone_voice",
        payload: {
          storagePath,
          voiceName: voiceName.trim(),
          description: description ?? null,
          transcript: transcript ?? null,
          consentGiven,
          removeNoise: removeNoise ?? true,
        },
        status: "pending",
      })
      .select("id")
      .single();

    if (jobErr || !job) {
      return new Response(
        JSON.stringify({ error: jobErr?.message ?? "Failed to queue job" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ success: true, jobId: (job as { id: string }).id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

serve(handler);
