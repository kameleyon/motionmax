import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { writeSystemLog } from "../_shared/log.ts";
import { requireAdmin, writeAuditLogOrFail } from "../_shared/adminGate.ts";

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

    // ── Auth + admin + MFA + freshness gate ─────────────────────────────
    // C-6-4 / Shield S-008 — force-signout is destructive (kicks the
    // target out of every session), so we require:
    //   • valid bearer JWT resolving to a user
    //   • admin role row
    //   • session ≤ 60 min old (forces re-auth on long-lived tokens)
    //   • AAL2 — admin completed TOTP this session
    const gate = await requireAdmin(req, supabaseAdmin, corsHeaders, {
      freshnessMinutes: 60,
      requireMfa: true,
    });
    if (!gate.ok) {
      logStep("Admin gate failed");
      return gate.response;
    }
    const callerUserId = gate.userId;
    logStep("Admin access verified", { callerUserId });

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

    // ── C-6-4 / Shield S-008: write the audit log FIRST and FAIL the
    // request if it doesn't land. Force-signout has a real (if
    // reversible) effect on the target; an undocumented force-signout
    // is exactly the kind of silent compromise this finding flags.
    const ipAddress = req.headers.get("x-forwarded-for") || null;
    const userAgent = req.headers.get("user-agent") || null;
    const auditWrite = await writeAuditLogOrFail(
      supabaseAdmin,
      {
        admin_id: callerUserId,
        action: "force_signout",
        target_type: "user",
        target_id: targetUserId,
        details: {
          reason: reason ?? null,
          banned_until: BANNED_UNTIL,
        },
        ip_address: ipAddress,
        user_agent: userAgent,
      },
      corsHeaders,
    );
    if (!auditWrite.ok) {
      logStep("ERROR: audit log insert failed; aborting force-signout");
      return auditWrite.response;
    }

    logStep("Audit row written, applying ban");

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

    // Mirror to system_logs so admin actions show on the unified
    // Activity Feed alongside non-admin events. admin_logs is the
    // authoritative store; system_logs is the streaming view.
    await writeSystemLog({
      supabase: supabaseAdmin,
      category: "system_warning",
      event_type: "admin.force_signout",
      userId: callerUserId,
      message: `Admin ${callerUserId} force-signed-out user ${targetUserId}`,
      details: {
        target_user_id: targetUserId,
        reason: reason ?? null,
        banned_until: BANNED_UNTIL,
      },
    });

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
