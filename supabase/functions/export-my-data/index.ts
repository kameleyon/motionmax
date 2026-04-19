import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit, getRateLimitHeaders } from "../_shared/rateLimit.ts";

/**
 * GDPR Article 20 — Data Portability
 * Returns all user data as a JSON payload.
 * Authenticated users can only export their own data.
 *
 * SECURITY:
 * - Rate limited to 1 export per hour per user
 * - Max export size: 10 MB
 * - CORS properly configured (no wildcard)
 */

const MAX_EXPORT_SIZE_MB = 10;
const MAX_EXPORT_SIZE_BYTES = MAX_EXPORT_SIZE_MB * 1024 * 1024;

serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(origin);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    // Create client with user's JWT to respect RLS
    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      }
    );

    // Verify the user is authenticated
    const {
      data: { user },
      error: authError,
    } = await supabaseUser.auth.getUser();

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    const userId = user.id;

    // Rate limiting: 1 export per hour per user
    const rateLimit = await checkRateLimit(supabaseUser, {
      key: "export-my-data",
      maxRequests: 1,
      windowSeconds: 3600, // 1 hour
      userId,
    });

    if (!rateLimit.allowed) {
      const resetDate = new Date(rateLimit.resetAt);
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          message: `You can request a data export once per hour. Try again after ${resetDate.toLocaleString()}.`,
          resetAt: rateLimit.resetAt,
        }),
        {
          headers: {
            ...corsHeaders,
            ...getRateLimitHeaders(rateLimit),
            "Content-Type": "application/json",
          },
          status: 429,
        }
      );
    }

    // Use service role to gather all data for this user
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    // Fetch all tables in parallel
    const [
      profileRes,
      projectsRes,
      generationsRes,
      subscriptionsRes,
      creditsRes,
      transactionsRes,
      costsRes,
      jobsRes,
      sharesRes,
    ] = await Promise.all([
      supabaseAdmin.from("profiles").select("*").eq("user_id", userId).maybeSingle(),
      supabaseAdmin.from("projects").select("*").eq("user_id", userId),
      supabaseAdmin.from("generations").select("*").eq("user_id", userId),
      supabaseAdmin.from("subscriptions").select("*").eq("user_id", userId),
      supabaseAdmin
        .from("user_credits")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle(),
      supabaseAdmin
        .from("credit_transactions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("generation_costs")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("video_generation_jobs")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false }),
      supabaseAdmin.from("project_shares").select("*").eq("user_id", userId),
    ]);

    const exportData = {
      exported_at: new Date().toISOString(),
      user_id: userId,
      email: user.email,
      profile: profileRes.data ?? null,
      projects: projectsRes.data ?? [],
      generations: generationsRes.data ?? [],
      subscriptions: subscriptionsRes.data ?? [],
      credits: creditsRes.data ?? null,
      credit_transactions: transactionsRes.data ?? [],
      generation_costs: costsRes.data ?? [],
      video_generation_jobs: jobsRes.data ?? [],
      project_shares: sharesRes.data ?? [],
    };

    // Check export size to prevent memory exhaustion
    const jsonString = JSON.stringify(exportData);
    const sizeBytes = new TextEncoder().encode(jsonString).length;

    if (sizeBytes > MAX_EXPORT_SIZE_BYTES) {
      return new Response(
        JSON.stringify({
          error: "Export too large",
          message: `Your data export exceeds the ${MAX_EXPORT_SIZE_MB}MB limit (${(sizeBytes / 1024 / 1024).toFixed(2)}MB). Please contact support for assistance.`,
          sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
        }),
        {
          headers: {
            ...corsHeaders,
            ...getRateLimitHeaders(rateLimit),
            "Content-Type": "application/json",
          },
          status: 413, // Payload Too Large
        }
      );
    }

    return new Response(jsonString, {
      headers: {
        ...corsHeaders,
        ...getRateLimitHeaders(rateLimit),
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="motionmax-data-export-${userId}.json"`,
      },
      status: 200,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[EXPORT-MY-DATA] Error:", message);
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
