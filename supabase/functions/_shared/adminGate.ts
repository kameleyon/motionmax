/**
 * C-6-4 / Shield S-008 — shared admin gate helpers for edge functions.
 *
 * Centralises three concerns that used to be ad-hoc per function:
 *   1. Admin role verification (user_roles.role = 'admin').
 *   2. Session freshness (re-auth required after 60 min for sensitive ops).
 *   3. AAL2 / MFA assertion for destructive ops.
 *
 * All checks are explicit + return early so the call sites stay grep-able.
 */

// deno-lint-ignore no-explicit-any
type SupabaseAdminClient = any;
// deno-lint-ignore no-explicit-any
type SupabaseUser = any;

export interface AdminGateOk {
  ok: true;
  user: SupabaseUser;
  userId: string;
  /** UNIX-epoch seconds at which the JWT was issued (iat). May be null
   *  for legacy tokens that don't carry one. */
  iatSec: number | null;
  /** Authenticator Assurance Level resolved from the JWT claims. */
  aal: "aal1" | "aal2" | null;
}
export interface AdminGateFail {
  ok: false;
  response: Response;
}
export type AdminGateResult = AdminGateOk | AdminGateFail;

interface AdminGateOptions {
  /** Default 60 — set 0 to disable freshness check. Sensitive admin ops
   *  should keep the default; data-read ops may relax to a higher window. */
  freshnessMinutes?: number;
  /** When true, require the JWT's aal claim to be 'aal2' (TOTP MFA verified
   *  within this session). For destructive admin ops only. */
  requireMfa?: boolean;
}

/**
 * Decode the JWT body without signature verification. We only use this
 * to read non-authoritative claims (iat / aal) AFTER the JWT has
 * already been validated by supabase.auth.getUser. Returning null on
 * any malformed input keeps callers fail-closed via the subsequent
 * checks rather than relying on the parsed value.
 */
function decodeJwtClaims(token: string): { iat?: number; aal?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    // base64url → base64
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(padded);
    const obj = JSON.parse(decoded);
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Run the standard admin gate. Returns either { ok: true, user, … } or
 * { ok: false, response } where response is the 401/403/412 the caller
 * should return immediately.
 *
 * Usage:
 *   const gate = await requireAdmin(req, supabaseAdmin, corsHeaders, { requireMfa: true });
 *   if (!gate.ok) return gate.response;
 *   // use gate.userId / gate.user
 */
export async function requireAdmin(
  req: Request,
  supabaseAdmin: SupabaseAdminClient,
  corsHeaders: Record<string, string>,
  options: AdminGateOptions = {},
): Promise<AdminGateResult> {
  const freshnessMinutes = options.freshnessMinutes ?? 60;
  const requireMfa = options.requireMfa === true;

  // ── 1. Bearer token + JWT-resolved user ─────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "No authorization header provided" },
        401,
        corsHeaders,
      ),
    };
  }
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !user) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "Authentication error: Invalid session" },
        401,
        corsHeaders,
      ),
    };
  }

  // ── 2. Admin role row (service-role bypasses RLS) ───────────────────
  const { data: adminRole, error: roleError } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();

  if (roleError || !adminRole) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "Access denied. Admin privileges required." },
        403,
        corsHeaders,
      ),
    };
  }

  // ── 3. Decode JWT for iat + aal ────────────────────────────────────
  const claims = decodeJwtClaims(token);
  const iatSec = typeof claims?.iat === "number" ? claims.iat : null;
  const aalRaw = typeof claims?.aal === "string" ? claims.aal : null;
  const aal: "aal1" | "aal2" | null =
    aalRaw === "aal2" ? "aal2" : aalRaw === "aal1" ? "aal1" : null;

  // ── 4. Session freshness ───────────────────────────────────────────
  // For sensitive admin ops we want to know the admin re-authed
  // recently — a stolen long-lived refresh token loses its value once
  // it's been kicking around past the freshness window. Prefer the
  // JWT's iat (when the access token was issued); fall back to
  // user.last_sign_in_at when iat is missing (extremely old SDK).
  if (freshnessMinutes > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    let signedInAtSec: number | null = null;
    if (iatSec !== null) {
      signedInAtSec = iatSec;
    } else if (user.last_sign_in_at) {
      const parsed = new Date(user.last_sign_in_at).getTime();
      if (!Number.isNaN(parsed)) signedInAtSec = Math.floor(parsed / 1000);
    }

    if (signedInAtSec === null || nowSec - signedInAtSec > freshnessMinutes * 60) {
      return {
        ok: false,
        response: jsonResponse(
          {
            error: "Session too old for this operation. Please sign out and sign back in.",
            code: "STALE_SESSION",
            freshness_minutes: freshnessMinutes,
          },
          412,
          corsHeaders,
        ),
      };
    }
  }

  // ── 5. AAL2 / MFA assertion ─────────────────────────────────────────
  // Supabase Auth stamps the JWT's `aal` claim with the highest
  // assurance level achieved THIS session. Requiring 'aal2' means the
  // admin completed a TOTP challenge this session, not just at enroll.
  if (requireMfa && aal !== "aal2") {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "MFA required for this operation.",
          code: "MFA_REQUIRED",
          required_aal: "aal2",
        },
        412,
        corsHeaders,
      ),
    };
  }

  return { ok: true, user, userId: user.id, iatSec, aal };
}

/**
 * Insert an admin_logs row and FAIL the request if the insert fails.
 *
 * Use this for destructive admin ops where a silent audit failure
 * would leave the action undocumented. The caller passes the supabase
 * client, the row, and the cors headers it would use for a 500
 * response. On failure we return a fully-formed Response that the
 * caller returns directly.
 */
export async function writeAuditLogOrFail(
  supabaseAdmin: SupabaseAdminClient,
  row: {
    admin_id: string;
    action: string;
    target_type: string;
    target_id: string | null;
    details: Record<string, unknown>;
    ip_address?: string | null;
    user_agent?: string | null;
  },
  corsHeaders: Record<string, string>,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const { error } = await supabaseAdmin.from("admin_logs").insert(row);
  if (error) {
    console.error("[adminGate] audit log insert failed; aborting action", error);
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "Failed to write audit log; action aborted.",
          code: "AUDIT_LOG_FAILURE",
        },
        500,
        corsHeaders,
      ),
    };
  }
  return { ok: true };
}

/**
 * Insert an admin_logs row with retry-once for non-destructive events.
 * Logs to console on terminal failure but does NOT block the action.
 *
 * Use for things like "admin listed users" where loss of a single row
 * is acceptable. Destructive ops MUST use writeAuditLogOrFail.
 */
export async function writeAuditLogBestEffort(
  supabaseAdmin: SupabaseAdminClient,
  row: {
    admin_id: string;
    action: string;
    target_type: string;
    target_id: string | null;
    details: Record<string, unknown>;
    ip_address?: string | null;
    user_agent?: string | null;
  },
): Promise<void> {
  const first = await supabaseAdmin.from("admin_logs").insert(row);
  if (!first.error) return;
  // Single retry with a small back-off. Don't sleep more than 200ms;
  // we're in an edge function hot path.
  await new Promise((r) => setTimeout(r, 100));
  const second = await supabaseAdmin.from("admin_logs").insert(row);
  if (second.error) {
    console.error(
      "[adminGate] audit log insert failed after retry",
      { action: row.action, target_id: row.target_id, err: second.error },
    );
  }
}
