import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { writeSystemLog } from "../_shared/log.ts";
import { requireAdmin, writeAuditLogOrFail } from "../_shared/adminGate.ts";

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[ADMIN-HARD-DELETE-USER] ${step}${detailsStr}`);
};

// RFC 4122 UUID validation (any version). Same regex used by
// admin-force-signout for consistency across admin edge functions.
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
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    // ── Auth + admin + MFA + freshness gate ─────────────────────────────
    // C-6-4 / Shield S-008 — hard-delete is irreversible (auth.users
    // row + CASCADE'd FKs). It's the most destructive admin op in the
    // system, so we require:
    //   • valid bearer JWT
    //   • admin role row
    //   • session ≤ 60 min old
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
    let body: { user_id?: unknown; confirmation?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const targetUserId = body?.user_id;
    const confirmation = body?.confirmation;

    if (typeof targetUserId !== "string" || !UUID_REGEX.test(targetUserId)) {
      return new Response(
        JSON.stringify({ error: "user_id is required and must be a valid UUID" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    if (typeof confirmation !== "string" || confirmation.length === 0) {
      return new Response(
        JSON.stringify({ error: "confirmation is required and must be a string" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    // ── Self-target guard ─────────────────────────────────────────────────
    // An admin hard-deleting themselves is destructive AND would lock
    // them out of the admin console mid-flight. Reject explicitly.
    if (targetUserId === callerUserId) {
      return new Response(
        JSON.stringify({ error: "Cannot hard-delete your own account" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    // ── Look up target user's email via service-role admin API.
    // We never trust the client-supplied confirmation as the source of
    // truth — the UI types in "delete <email>" but the SERVER pulls the
    // canonical email from auth.users and compares. This prevents a
    // compromised/buggy client from hard-deleting an arbitrary user by
    // submitting a self-supplied "matching" string.
    const { data: targetUserData, error: targetUserError } =
      await supabaseAdmin.auth.admin.getUserById(targetUserId);

    if (targetUserError || !targetUserData?.user) {
      logStep("ERROR: getUserById failed", {
        targetUserId,
        error: targetUserError?.message,
      });
      return new Response(
        JSON.stringify({ error: "Target user not found" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 404,
        }
      );
    }

    const targetEmail = targetUserData.user.email;
    if (!targetEmail) {
      // Shouldn't happen for password-auth users, but auth.users.email
      // is technically nullable (e.g., phone-only accounts). Without an
      // email we cannot perform the typed-confirm step at all, so
      // refuse rather than fall through to deletion.
      logStep("ERROR: target user has no email on record", { targetUserId });
      return new Response(
        JSON.stringify({
          error: "Target user has no email; hard-delete via this endpoint is not supported",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    // Case-insensitive compare: GoTrue normalizes emails to lowercase
    // server-side, but a defensive lowercase on both sides keeps us
    // robust to any caller that hasn't already normalized.
    if (confirmation.toLowerCase() !== targetEmail.toLowerCase()) {
      logStep("Confirmation mismatch", { targetUserId });
      return new Response(
        JSON.stringify({ error: "Confirmation does not match user email" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    logStep("Hard-delete confirmed", { targetUserId });

    // ── Audit log FIRST. Hard delete is irreversible; we want the
    // admin_logs row durably written before we touch auth.users so a
    // crash between the two steps still leaves us with a record of
    // intent. admin_logs.target_id has no FK to auth.users (per
    // 20260201152356 + 20260419000021 which only added a FK on
    // admin_id), so the audit row survives the cascade.
    // C-6-4 / Shield S-008 — fail-loud via the shared helper so this
    // matches the other destructive admin ops.
    const ipAddress = req.headers.get("x-forwarded-for") || null;
    const userAgent = req.headers.get("user-agent") || null;
    const auditWrite = await writeAuditLogOrFail(
      supabaseAdmin,
      {
        admin_id: callerUserId,
        action: "hard_delete_user",
        target_type: "user",
        target_id: targetUserId,
        details: {
          deleted_email: targetEmail,
          ip: ipAddress,
        },
        ip_address: ipAddress,
        user_agent: userAgent,
      },
      corsHeaders,
    );
    if (!auditWrite.ok) {
      logStep("ERROR: admin_logs insert failed; aborting hard delete");
      return auditWrite.response;
    }

    logStep("Audit row written, proceeding with deleteUser");

    // ── Perform the hard delete via Auth admin API. shouldSoftDelete
    // is explicitly false — Postgres CASCADE on auth.users will clean
    // up profiles, projects, generations, etc. (FKs were added by the
    // initial schema and 20260419000021_add_user_id_foreign_keys.sql).
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(
      targetUserId,
      false
    );

    if (deleteError) {
      logStep("ERROR: deleteUser failed", { error: deleteError.message });
      return new Response(
        JSON.stringify({
          error: deleteError.message || "Failed to delete user",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        }
      );
    }

    logStep("User hard-deleted", { targetUserId });

    await writeSystemLog({
      supabase: supabaseAdmin,
      category: "user_activity",
      event_type: "user.account_deleted",
      userId: targetUserId,
      message: `Admin hard-deleted user ${targetUserId}`,
      details: { admin_id: callerUserId, mode: "hard_delete" },
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
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
