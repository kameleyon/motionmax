// MotionMax Public API — /api/v1/keys (collection)
//
//   POST /api/v1/keys  — mint a new API key for the caller's account.
//   GET  /api/v1/keys  — list this account's keys (token_hash NEVER included).
//
// Auth: requireUser() (browser/JWT caller) — a customer drives this from the
// dashboard and CANNOT present an mm_ key here because they are minting their
// first one. requireUser throws a Response on failure, returned verbatim via
// isResponse(e).
//
// The owner-scoped management RPCs (api_create_key) call
// api_assert_account_owner() which checks auth.uid(); they MUST be invoked via
// requireUser's JWT-scoped `userClient` (auth.uid() = user.id), NOT the plain
// service-role client (auth.uid() = NULL → 42501).
//
// Ownership: this file owns the collection routes only. The item routes
// (/api/v1/keys/{id} rotate/revoke) live in the sibling [id]/index.ts handler.

import { webHandler } from "../../_shared/webHandler";
import { handlePreflight } from "../../_shared/cors";
import { logError } from "../../_shared/platformConfig";
import { isResponse } from "../../_shared/auth";
import { requireUser } from "../../_shared/userAuth";
import {
  apiError,
  apiJson,
  newRequestId,
  type ApiKeyEnv,
} from "../_shared/contract";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const VALID_ENVS: ReadonlySet<string> = new Set<ApiKeyEnv>(["live", "test"]);
const DEFAULT_ENV: ApiKeyEnv = "live";
const MAX_SCOPES = 64;
const MAX_SCOPE_CHARS = 128;

// ─────────────────────────────────────────────────────────────────────────────
// Request parsing / validation (POST)
// ─────────────────────────────────────────────────────────────────────────────

interface CreateKeyInput {
  env: ApiKeyEnv;
  scopes: string[];
}

type ValidationResult =
  | { ok: true; value: CreateKeyInput }
  | { ok: false; message: string };

function validateCreateBody(raw: unknown): ValidationResult {
  // An empty/absent body is valid — both fields are optional with defaults.
  const body: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  // env — optional enum, defaults to 'live'.
  let env: ApiKeyEnv = DEFAULT_ENV;
  if (body.env !== undefined && body.env !== null) {
    if (typeof body.env !== "string" || !VALID_ENVS.has(body.env)) {
      return { ok: false, message: "`env` must be one of: live, test." };
    }
    env = body.env as ApiKeyEnv;
  }

  // scopes — optional string[].
  let scopes: string[] = [];
  if (body.scopes !== undefined && body.scopes !== null) {
    if (!Array.isArray(body.scopes)) {
      return { ok: false, message: "`scopes` must be an array of strings." };
    }
    if (body.scopes.length > MAX_SCOPES) {
      return { ok: false, message: `\`scopes\` exceeds the ${MAX_SCOPES} entry limit.` };
    }
    for (const s of body.scopes) {
      if (typeof s !== "string" || s.length === 0 || s.length > MAX_SCOPE_CHARS) {
        return {
          ok: false,
          message: `Each scope must be a non-empty string up to ${MAX_SCOPE_CHARS} characters.`,
        };
      }
    }
    scopes = body.scopes as string[];
  }

  return { ok: true, value: { env, scopes } };
}

async function parseJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text || text.trim().length === 0) return {};
  return JSON.parse(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export default webHandler(async (req): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const origin = req.headers.get("origin");
  const requestId = newRequestId();
  const method = (req.method || "GET").toUpperCase();

  // Authenticate the browser/JWT caller and resolve their account.
  let auth;
  try {
    auth = await requireUser(req);
  } catch (e) {
    if (isResponse(e)) return e;
    logError("api.v1.keys.requireUser", e);
    return apiError(500, "internal_error", "Authentication failed.", origin, requestId);
  }
  const { account, userClient } = auth;

  // ── POST: create a key ─────────────────────────────────────────────────────
  if (method === "POST") {
    let raw: unknown;
    try {
      raw = await parseJsonBody(req);
    } catch {
      return apiError(400, "invalid_json", "Request body is not valid JSON.", origin, requestId);
    }

    const validation = validateCreateBody(raw);
    if (!validation.ok) {
      return apiError(400, "invalid_request", validation.message, origin, requestId);
    }
    const { env, scopes } = validation.value;

    // Owner-checked RPC — invoked via the JWT-scoped client so auth.uid() is set.
    const { data, error } = await userClient.rpc("api_create_key", {
      p_account_id: account.id,
      p_env: env,
      p_scopes: scopes,
    });

    if (error) {
      logError("api.v1.keys.create", error, { account_id: account.id, env });
      return apiError(
        500,
        "key_create_failed",
        "Could not create the API key.",
        origin,
        requestId,
      );
    }

    const row = (data ?? {}) as {
      id?: string;
      token?: string;
      prefix?: string;
      last4?: string;
      env?: string;
    };

    // NOTE: `token` is the PLAINTEXT key and is returned here ONE TIME ONLY.
    // It is never persisted in plaintext and never surfaced again (the list
    // route reads api_keys_public, which excludes token_hash entirely). The
    // caller MUST store it now; a lost token requires rotation.
    return apiJson(
      201,
      {
        id: row.id,
        prefix: row.prefix,
        last4: row.last4,
        env: row.env,
        token: row.token,
      },
      origin,
    );
  }

  // ── GET: list keys ─────────────────────────────────────────────────────────
  if (method === "GET") {
    // api_keys_public is a VIEW that exposes every column EXCEPT token_hash, so
    // a plaintext/hashed secret can never leak through the list path.
    const { data, error } = await userClient
      .from("api_keys_public")
      .select("*")
      .eq("account_id", account.id)
      .order("created_at", { ascending: false });

    if (error) {
      logError("api.v1.keys.list", error, { account_id: account.id });
      return apiError(
        500,
        "key_list_failed",
        "Could not list API keys.",
        origin,
        requestId,
      );
    }

    return apiJson(200, { data: data ?? [] }, origin);
  }

  return apiError(405, "method_not_allowed", `Method ${method} not allowed.`, origin, requestId);
});
