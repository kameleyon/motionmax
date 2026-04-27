import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[ADMIN-FORCE-SIGNOUT] ${step}${detailsStr}`);
};

// RFC 4122 UUID validation (any version)
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Far-future ban timestamp — effectively permanent JWT invalidation
const BANNED_UNTIL = "2099-12-31T23:59:59Z";

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST." }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 405,
    });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    // ── Auth: extract caller from JWT ─────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "No authorization header provided" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 401,
        }
      );
    }

    const token = authHeader.replace("Bearer ", "");

    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Authentication error: Invalid session" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 401,
        }
      );
    }

    const callerUserId = user.id;
    logStep("User authenticated", { callerUserId });

    // ── Admin check: same pattern as admin-stats (user_roles.role = 'admin') ─
    const { data: adminRole, error: roleError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", callerUserId)
      .eq("role", "admin")
      .single();

    if (roleError || !adminRole) {
      logStep("Access denied - not admin", { callerUserId });
      return new Response(
        JSON.stringify({ error: "Access denied. Admin privileges required." }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 403,
        }
      );
    }

    logStep("Admin access verified");

    // ── Parse + validate body ─────────────────────────────────────────────
    let body: { user_id?: unknown; reason?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const targetUserId = body?.user_id;
    const reason = body?.reason;

    if (typeof targetUserId !== "string" || !UUID_REGEX.test(targetUserId)) {
      return new Response(
        JSON.stringify({ error: "user_id is required and must be a valid UUID" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    if (reason !== undefined && typeof reason !== "string") {
      return new Response(
        JSON.stringify({ error: "reason, if provided, must be a string" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    // ── Self-target guard: an admin force-signing-out themselves locks
    // them out of their own admin tooling. Reject explicitly.
    if (targetUserId === callerUserId) {
      return new Response(
        JSON.stringify({ error: "Cannot force-signout your own account" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    logStep("Force-signout requested", { targetUserId, hasReason: !!reason });

    // ── Apply ban via Auth admin API. Setting banned_until causes
    // GoTrue to reject any existing JWT for this user on its next
    // refresh / verification, which is what actually kicks them off.
    const { data: updateData, error: updateError } =
      await supabaseAdmin.auth.admin.updateUserById(targetUserId, {
        banned_until: BANNED_UNTIL,
      });

    if (updateError || !updateData?.user) {
      logStep("ERROR: updateUserById failed", { error: updateError?.message });
      return new Response(
        JSON.stringify({
          error: updateError?.message || "Failed to update user ban status",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        }
      );
    }

    logStep("User banned_until applied", { targetUserId, banned_until: BANNED_UNTIL });

    // ── Audit log. Column names match the live admin_logs schema
    // (see migration 20260201152356) used everywhere in admin-stats:
    // admin_id, action, target_type, target_id, details, ip_address, user_agent.
    // Awaited (not fire-and-forget) so the orchestrator sees the audit
    // trail before the response returns; this is a privileged action.
    const { error: logError } = await supabaseAdmin.from("admin_logs").insert({
      admin_id: callerUserId,
      action: "force_signout",
      target_type: "user",
      target_id: targetUserId,
      details: {
        reason: reason ?? null,
        banned_until: BANNED_UNTIL,
      },
      ip_address: req.headers.get("x-forwarded-for") || null,
      user_agent: req.headers.get("user-agent") || null,
    });

    if (logError) {
      // The ban already took effect; surface the audit failure but
      // don't pretend the ban itself failed.
      logStep("WARNING: admin_logs insert failed", { error: logError.message });
    }

    return new Response(
      JSON.stringify({ success: true, banned_until: BANNED_UNTIL }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
}
serve(handler);
