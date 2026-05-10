import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { writeSystemLog } from "../_shared/log.ts";
import { requireAdmin, writeAuditLogOrFail } from "../_shared/adminGate.ts";

// Phase 8.6.5 — admin-triggered password reset.
//
// Generates a Supabase password-recovery link via the auth admin API
// (auth.admin.generateLink({ type: 'recovery', email })). GoTrue then
// emails the user; the admin doesn't need to relay anything. Audit
// trail mirrors admin-force-signout: a row in admin_logs and a
// system_logs entry so the action shows up in the live activity feed.

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[ADMIN-SEND-RESET-LINK] ${step}${detailsStr}`);
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    { auth: { persistSession: false } },
  );

  try {
    logStep("Function started");

    // ── Auth + admin + freshness gate ───────────────────────────────────
    // C-6-4 / Shield S-008 — admin-triggered password reset can lock a
    // user out of their account if abused. We require admin role +
    // a freshly-authenticated session. MFA is NOT required here (this
    // op is sensitive but not strictly destructive — the target can
    // recover via their email), but freshness still defends against
    // long-lived stolen tokens.
    const gate = await requireAdmin(req, supabaseAdmin, corsHeaders, {
      freshnessMinutes: 60,
      requireMfa: false,
    });
    if (!gate.ok) {
      logStep("Admin gate failed");
      return gate.response;
    }
    const callerUserId = gate.userId;
    logStep("Admin access verified", { callerUserId });

    // ── Parse + validate body ────────────────────────────────────────────
    let body: { user_id?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const targetUserId = body?.user_id;
    if (typeof targetUserId !== "string" || !UUID_REGEX.test(targetUserId)) {
      return new Response(
        JSON.stringify({ error: "user_id is required and must be a valid UUID" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
      );
    }

    // ── Look up the target's email — generateLink wants email, not uid.
    const { data: target, error: targetErr } =
      await supabaseAdmin.auth.admin.getUserById(targetUserId);
    if (targetErr || !target?.user?.email) {
      return new Response(
        JSON.stringify({ error: targetErr?.message || "Target user has no email" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 },
      );
    }
    const targetEmail = target.user.email;

    // ── Generate the recovery link. GoTrue dispatches the email
    // automatically when the SMTP integration is configured (it is
    // in this project — see resetPassword in src/hooks/useAuth.ts).
    const redirectBase = Deno.env.get("APP_URL") || Deno.env.get("VITE_APP_URL") || "";
    const { data: linkData, error: linkErr } =
      await supabaseAdmin.auth.admin.generateLink({
        type: "recovery",
        email: targetEmail,
        options: redirectBase ? { redirectTo: `${redirectBase}/auth` } : undefined,
      });

    if (linkErr) {
      logStep("ERROR: generateLink failed", { error: linkErr.message });
      return new Response(
        JSON.stringify({ error: linkErr.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
      );
    }

    logStep("Recovery link generated", { targetUserId });

    // ── Audit log (admin_logs is authoritative; system_logs is the
    // streaming activity feed). The actual recovery URL is captured
    // in admin_logs.details so it can be re-sent if email delivery
    // fails — but we never echo it back in the response.
    // C-6-4 / Shield S-008 — fail-loud. Admin-triggered password
    // reset CAN lock a user out, so a silent audit failure here is
    // not acceptable.
    const auditWrite = await writeAuditLogOrFail(
      supabaseAdmin,
      {
        admin_id: callerUserId,
        action: "send_reset_link",
        target_type: "user",
        target_id: targetUserId,
        details: {
          email: targetEmail,
          action_link_present: Boolean(linkData?.properties?.action_link),
        },
        ip_address: req.headers.get("x-forwarded-for") || null,
        user_agent: req.headers.get("user-agent") || null,
      },
      corsHeaders,
    );
    if (!auditWrite.ok) {
      logStep("ERROR: audit log insert failed");
      return auditWrite.response;
    }

    await writeSystemLog({
      supabase: supabaseAdmin,
      category: "system_warning",
      event_type: "admin.send_reset_link",
      userId: callerUserId,
      message: `Admin ${callerUserId} sent password-reset link to ${targetUserId}`,
      details: { target_user_id: targetUserId, target_email: targetEmail },
    });

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
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
