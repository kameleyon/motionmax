// MotionMax Public API — end-user (browser-JWT) auth guard.
//
// Sibling to requireAdmin (api/_shared/auth.ts) and requireApiKey
// (api/_shared/apiKeyAuth.ts). Used by the self-serve account surfaces that a
// CUSTOMER (not an API key) drives from the dashboard — primarily API-key
// management (/api/v1/keys), where a customer cannot present an mm_ key because
// they're minting their first one.
//
// It verifies a Supabase session JWT, resolves the caller's single `accounts`
// row (owner_user_id = user.id), and returns BOTH a service-role client and a
// JWT-scoped client. The owner-scoped management RPCs (api_create_key /
// api_rotate_key / api_revoke_key) call api_assert_account_owner() which checks
// auth.uid(); a plain service-role client has auth.uid() = NULL and would be
// rejected (42501). The JWT-scoped `userClient` carries the user's bearer token
// in the Authorization header so PostgREST resolves role=authenticated and
// auth.uid()=user.id, satisfying the owner check.
//
// Convention matches the sibling guards: this THROWS a Response on failure,
// caught by the handler via isResponse(e) (re-exported from auth.ts).

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { createAdminClient } from "./supabaseAdmin";
import { corsHeaders } from "./cors";
import type { AccountRecord } from "../v1/_shared/contract";

export type AccountMemberRole = "owner" | "admin" | "member";

/**
 * Account resolved for the caller, plus the caller's role on it. `role` is a
 * SIBLING field (AccountRecord itself has no role) so existing owner callers
 * that only read `account.{id,owner_user_id,tier,status}` are unchanged.
 * For the legacy owner path role is always 'owner'.
 */
export type ResolvedAccount = AccountRecord & { role: AccountMemberRole };

export interface UserAuthOk {
  user: User;
  account: ResolvedAccount;
  /** Service-role client (RLS-bypassing). */
  supabase: SupabaseClient;
  /** JWT-scoped client — auth.uid() = user.id; use for owner-checked RPCs. */
  userClient: SupabaseClient;
  jwt: string;
}

function jsonError(status: number, body: object, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

function extractJwt(req: Request): string | null {
  // Authorization header ONLY. No ?token= query fallback: a session JWT in a URL
  // leaks via access logs, Referer headers, and browser history — and this guard
  // mints/rotates API keys. If a non-header transport is ever needed (EventSource),
  // use a short-lived single-use ticket, not the long-lived session JWT.
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m && m[1] ? m[1].trim() : null;
}

function normalizeTier(tier: string | null | undefined): AccountRecord["tier"] {
  return tier === "creator" ? "creator" : tier === "studio" ? "studio" : "free";
}

function normalizeRole(role: string | null | undefined): AccountMemberRole {
  return role === "owner" ? "owner" : role === "admin" ? "admin" : "member";
}

/**
 * Authenticate a customer by their Supabase session JWT and resolve their
 * account. Throws a Response on: missing token (401), invalid token (401),
 * no account (403), suspended account (403).
 */
export async function requireUser(req: Request): Promise<UserAuthOk> {
  const origin = req.headers.get("origin");
  const supabase = createAdminClient();

  const jwt = extractJwt(req);
  if (!jwt) {
    throw jsonError(401, { error: "missing_authorization", message: "Missing bearer token" }, origin);
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    throw jsonError(401, { error: "invalid_token", message: userErr?.message ?? "Invalid session token" }, origin);
  }
  const user = userData.user;

  // Account resolution, two-tier and backward-compatible:
  //   1. OWNER path (legacy): the single account whose owner_user_id = user.id.
  //      Existing single-user callers always land here, role = 'owner'.
  //   2. MEMBERSHIP path: if the user owns no account, resolve via
  //      account_members. If they belong to several, honor the optional
  //      'X-Account-Id' request header; otherwise pick the first by created_at.
  let acct: { id: string; owner_user_id: string; tier: string | null; status: string | null } | null = null;
  let role: AccountMemberRole = "owner";

  const { data: ownerRow, error: ownerErr } = await supabase
    .from("accounts")
    .select("id, owner_user_id, tier, status")
    .eq("owner_user_id", user.id)
    .maybeSingle();

  if (ownerErr) {
    throw jsonError(500, { error: "account_lookup_failed", message: ownerErr.message }, origin);
  }

  if (ownerRow) {
    acct = ownerRow as { id: string; owner_user_id: string; tier: string | null; status: string | null };
    role = "owner";
  } else {
    // No owned account — try membership.
    const { data: memberRows, error: memberErr } = await supabase
      .from("account_members")
      .select("account_id, role, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });

    if (memberErr) {
      throw jsonError(500, { error: "account_lookup_failed", message: memberErr.message }, origin);
    }

    const memberships = (memberRows ?? []) as Array<{
      account_id: string;
      role: string | null;
      created_at: string;
    }>;

    if (memberships.length === 0) {
      throw jsonError(403, { error: "no_account", message: "No account is provisioned for this user." }, origin);
    }

    // Optional account selection when the user belongs to multiple accounts.
    const requestedAccountId = req.headers.get("x-account-id");
    let chosen = memberships[0];
    if (requestedAccountId) {
      const match = memberships.find((m) => m.account_id === requestedAccountId);
      if (!match) {
        throw jsonError(403, { error: "not_a_member", message: "You are not a member of the requested account." }, origin);
      }
      chosen = match;
    }

    role = normalizeRole(chosen.role);

    const { data: acctRow, error: acctErr } = await supabase
      .from("accounts")
      .select("id, owner_user_id, tier, status")
      .eq("id", chosen.account_id)
      .maybeSingle();

    if (acctErr) {
      throw jsonError(500, { error: "account_lookup_failed", message: acctErr.message }, origin);
    }
    if (!acctRow) {
      throw jsonError(403, { error: "no_account", message: "The member's account no longer exists." }, origin);
    }
    acct = acctRow as { id: string; owner_user_id: string; tier: string | null; status: string | null };
  }

  if (acct.status === "suspended") {
    throw jsonError(403, { error: "account_suspended", message: "This account is suspended." }, origin);
  }

  // JWT-scoped client: service URL/key as apikey, but the user's bearer token in
  // Authorization so PostgREST sets role=authenticated + auth.uid()=user.id.
  const url = process.env.SUPABASE_URL as string;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
  const userClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });

  const account: ResolvedAccount = {
    id: acct.id,
    owner_user_id: acct.owner_user_id,
    tier: normalizeTier(acct.tier),
    status: "active",
    role,
  };

  return { user, account, supabase, userClient, jwt };
}
