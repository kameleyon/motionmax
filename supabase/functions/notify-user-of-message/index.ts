import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { sendSupportEmail } from "../_shared/resend.ts";
import { writeSystemLog } from "../_shared/log.ts";

// Phase 8.6.4 / 13.x — admin → user email copy.
//
// Called by UserDrawer's Communicate panel when the email-copy toggle is
// on. Looks up the target user's email, sends a styled message from the
// support address (so replies land in the support inbox), and audits the
// action. Idempotent at the API level (no DB-side dedupe — admins can
// resend an email if they need to).

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[NOTIFY-USER-OF-MESSAGE] ${step}${detailsStr}`);
};

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return handleCorsPreflightRequest(req.headers.get("origin"));

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 405,
    });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401,
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user: caller } } = await supabaseAdmin.auth.getUser(token);
    if (!caller) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401,
      });
    }

    // Admin gate (matches admin-force-signout / admin-send-reset-link).
    const { data: adminRole } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .eq("role", "admin")
      .single();
    if (!adminRole) {
      return new Response(JSON.stringify({ error: "Admin privileges required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 403,
      });
    }

    let body: { user_id?: unknown; subject?: unknown; body?: unknown };
    try { body = await req.json(); }
    catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
      });
    }
    const targetUserId = body.user_id;
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const messageBody = typeof body.body === "string" ? body.body.trim() : "";
    if (typeof targetUserId !== "string" || !UUID_REGEX.test(targetUserId)) {
      return new Response(JSON.stringify({ error: "user_id must be a valid UUID" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
      });
    }
    if (!subject || !messageBody) {
      return new Response(JSON.stringify({ error: "subject and body are required" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400,
      });
    }

    const { data: target } = await supabaseAdmin.auth.admin.getUserById(targetUserId);
    if (!target?.user?.email) {
      return new Response(JSON.stringify({ error: "Target user has no email" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404,
      });
    }
    const targetEmail = target.user.email;

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.55">
        <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(subject)}</h2>
        <div style="white-space:pre-wrap">${escapeHtml(messageBody)}</div>
        <p style="color:#777;font-size:12px;margin-top:24px">Replying to this email reaches MotionMax support.</p>
      </div>
    `;
    await sendSupportEmail(targetEmail, subject, html);
    logStep("Email sent", { from_admin: caller.id, to: targetUserId });

    await supabaseAdmin.from("admin_logs").insert({
      admin_id: caller.id,
      action: "email_user",
      target_type: "user",
      target_id: targetUserId,
      details: { subject, target_email: targetEmail },
      ip_address: req.headers.get("x-forwarded-for") || null,
      user_agent: req.headers.get("user-agent") || null,
    });

    await writeSystemLog({
      supabase: supabaseAdmin,
      category: "system_info",
      event_type: "admin.email_user",
      userId: caller.id,
      message: `Admin ${caller.id} emailed user ${targetUserId}`,
      details: { target_user_id: targetUserId, subject },
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500,
    });
  }
}

serve(handler);
