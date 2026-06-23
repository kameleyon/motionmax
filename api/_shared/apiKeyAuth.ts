// MotionMax Public API — customer API-key auth guard.
//
// Sibling to requireAdmin() (api/_shared/auth.ts): same throw-a-Response
// convention (caught via isResponse(e) and returned verbatim), same
// service-role client. Where requireAdmin verifies a browser JWT + is_admin,
// this verifies a MotionMax-issued customer API key (`mm_live_…` / `mm_test_…`)
// against public.api_keys and resolves its owning public.accounts row.
//
// The whole /api/v1 surface depends on this: it is the ONLY place Bearer
// extraction, token-hash lookup, expired/rotated/revoked rejection, and
// account-suspension enforcement live. Owner scoping downstream is by
// account_id / account.owner_user_id — never a bare user filter.
//
// Hashing matches the SQL side exactly: sha-256 hex of the full token, the same
// scheme public.api_keys (and internal_api_keys before it) stores in token_hash
// via encode(digest(token,'sha256'),'hex').

import { createHash } from "crypto";
import { createAdminClient } from "./supabaseAdmin";
import {
  apiError,
  type AccountRecord,
  type ApiKeyAuthOk,
  type ApiKeyEnv,
  type ApiKeyRecord,
} from "../v1/_shared/contract";

/** sha-256 hex of the presented token — matches SQL digest(token,'sha256'). */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Pull the API key from `Authorization: Bearer <key>` (the only accepted form). */
function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m && m[1] ? m[1].trim() : null;
}

interface ApiKeyRow {
  id: string;
  account_id: string;
  env: string | null;
  prefix: string | null;
  scopes: string[] | null;
  status: string | null;
  expires_at: string | null;
}

interface AccountRow {
  id: string;
  owner_user_id: string;
  tier: string | null;
  status: string | null;
}

function normalizeTier(tier: string | null): AccountRecord["tier"] {
  return tier === "creator" ? "creator" : tier === "studio" ? "studio" : "free";
}

function normalizeEnv(env: string | null, prefix: string | null): ApiKeyEnv {
  if (env === "test" || env === "live") return env;
  // Fall back to the key prefix (mm_test_ / mm_live_) when the column is unset.
  return prefix && prefix.includes("test") ? "test" : "live";
}

/**
 * Authenticate a /api/v1 request by its customer API key.
 *
 * Throws (never returns) a frozen-envelope Response on any failure:
 *   401 missing_api_key   — no Bearer token
 *   401 invalid_api_key   — unknown / rotated / revoked / orphaned key
 *   401 expired_api_key   — past expires_at
 *   403 account_suspended — owning account is suspended
 * On success returns { apiKey, account, supabase } (service-role client) and
 * fires a best-effort usage bump.
 */
export async function requireApiKey(req: Request): Promise<ApiKeyAuthOk> {
  const origin = req.headers.get("origin");

  const token = extractBearer(req);
  if (!token) {
    throw apiError(
      401,
      "missing_api_key",
      "Provide your API key as 'Authorization: Bearer <key>'.",
      origin,
    );
  }

  const supabase = createAdminClient();
  const tokenHash = hashApiKey(token);

  // 1) Look up the key by its hash (service role; token_hash is UNIQUE).
  const { data: keyData, error: keyErr } = await supabase
    .from("api_keys")
    .select("id, account_id, env, prefix, scopes, status, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (keyErr) {
    throw apiError(500, "auth_error", "Failed to verify the API key.", origin);
  }
  if (!keyData) {
    throw apiError(401, "invalid_api_key", "The provided API key is not valid.", origin);
  }
  const key = keyData as ApiKeyRow;

  if (key.status !== "active") {
    throw apiError(401, "invalid_api_key", "This API key has been rotated or revoked.", origin);
  }
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) {
    throw apiError(401, "expired_api_key", "This API key has expired.", origin);
  }

  // 2) Resolve the owning account.
  const { data: acctData, error: acctErr } = await supabase
    .from("accounts")
    .select("id, owner_user_id, tier, status")
    .eq("id", key.account_id)
    .maybeSingle();

  if (acctErr) {
    throw apiError(500, "auth_error", "Failed to load the account.", origin);
  }
  if (!acctData) {
    throw apiError(401, "invalid_api_key", "This API key is not linked to an account.", origin);
  }
  const account = acctData as AccountRow;

  if (account.status === "suspended") {
    throw apiError(403, "account_suspended", "This account is suspended.", origin);
  }

  // 3) Best-effort usage bump (last_used_at + calls_count). Fire-and-forget so a
  //    metering hiccup never blocks or fails the request.
  void supabase.rpc("api_key_touch", { p_id: key.id }).then(
    () => {},
    () => {},
  );

  const apiKey: ApiKeyRecord = {
    id: key.id,
    account_id: key.account_id,
    env: normalizeEnv(key.env, key.prefix),
    prefix: key.prefix ?? "",
    scopes: Array.isArray(key.scopes) ? key.scopes : [],
    status: "active",
  };

  const accountRecord: AccountRecord = {
    id: account.id,
    owner_user_id: account.owner_user_id,
    tier: normalizeTier(account.tier),
    status: "active",
  };

  return { apiKey, account: accountRecord, supabase };
}
