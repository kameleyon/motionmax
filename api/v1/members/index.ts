// MotionMax Public API — /api/v1/members (collection)
//
//   GET  /api/v1/members  — list the caller's account roster (owner/admin only).
//   POST /api/v1/members  — add a member by email (owner/admin only).
//
// Auth: requireUser() (browser/JWT caller) — teams are managed from the
// dashboard. requireUser throws a Response on failure, returned verbatim via
// isResponse(e), and resolves the caller's account (owner OR membership).
//
// The membership RPCs (api_list_members / api_add_member) assert owner/admin
// rights INTERNALLY via api_assert_account_owner() (auth.uid()), so they MUST
// be called through the JWT-scoped `userClient`. A non-owner/admin caller gets
// a Postgres 42501 which we surface as 403 forbidden.
//
// Ownership: this file owns the collection routes only. The item route
// (/api/v1/members/{id} remove) lives in the sibling [id]/index.ts handler.

import { webHandler } from "../../_shared/webHandler";
import { handlePreflight } from "../../_shared/cors";
import { logError } from "../../_shared/platformConfig";
import { isResponse } from "../../_shared/auth";
import { requireUser } from "../../_shared/userAuth";
import { apiError, apiJson, newRequestId } from "../_shared/contract";

const VALID_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "member"]);
const DEFAULT_ROLE = "member";
const MAX_EMAIL_CHARS = 320; // RFC 5321 max addressable length.

interface AddMemberInput {
  email: string;
  role: string;
}

type ValidationResult =
  | { ok: true; value: AddMemberInput }
  | { ok: false; message: string };

function validateAddBody(raw: unknown): ValidationResult {
  const body: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  // email — required.
  if (typeof body.email !== "string" || body.email.trim().length === 0) {
    return { ok: false, message: "`email` is required." };
  }
  const email = body.email.trim();
  if (email.length > MAX_EMAIL_CHARS || !email.includes("@")) {
    return { ok: false, message: "`email` is not a valid address." };
  }

  // role — optional enum, defaults to 'member'.
  let role = DEFAULT_ROLE;
  if (body.role !== undefined && body.role !== null) {
    if (typeof body.role !== "string" || !VALID_ROLES.has(body.role)) {
      return { ok: false, message: "`role` must be one of: owner, admin, member." };
    }
    role = body.role;
  }

  return { ok: true, value: { email, role } };
}

async function parseJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text || text.trim().length === 0) return {};
  return JSON.parse(text);
}

/**
 * Membership RPCs assert owner/admin internally and raise on failure. The
 * Postgres 42501 (insufficient_privilege) maps to a 403; P0002 (no_data) maps
 * to 404. Anything else is a 500.
 */
function mapRpcError(
  error: { code?: string; message?: string },
  origin: string | null,
  requestId: string,
  notFoundMessage: string,
): Response {
  if (error.code === "42501") {
    return apiError(403, "forbidden", "You do not have permission to manage this account's members.", origin, requestId);
  }
  if (error.code === "P0002") {
    return apiError(404, "not_found", notFoundMessage, origin, requestId);
  }
  if (error.code === "22023") {
    return apiError(400, "invalid_request", error.message ?? "Invalid request.", origin, requestId);
  }
  return apiError(500, "internal_error", "The request could not be completed.", origin, requestId);
}

export default webHandler(async (req): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const origin = req.headers.get("origin");
  const requestId = newRequestId();
  const method = (req.method || "GET").toUpperCase();

  let auth;
  try {
    auth = await requireUser(req);
  } catch (e) {
    if (isResponse(e)) return e;
    logError("api.v1.members.requireUser", e);
    return apiError(500, "internal_error", "Authentication failed.", origin, requestId);
  }
  const { account, userClient } = auth;

  // ── GET: list members ────────────────────────────────────────────────────
  if (method === "GET") {
    const { data, error } = await userClient.rpc("api_list_members", {
      p_account_id: account.id,
    });

    if (error) {
      logError("api.v1.members.list", error, { account_id: account.id });
      return mapRpcError(error, origin, requestId, "Account not found.");
    }

    return apiJson(200, { data: data ?? [] }, origin);
  }

  // ── POST: add a member ───────────────────────────────────────────────────
  if (method === "POST") {
    let raw: unknown;
    try {
      raw = await parseJsonBody(req);
    } catch {
      return apiError(400, "invalid_json", "Request body is not valid JSON.", origin, requestId);
    }

    const validation = validateAddBody(raw);
    if (!validation.ok) {
      return apiError(400, "invalid_request", validation.message, origin, requestId);
    }
    const { email, role } = validation.value;

    const { data, error } = await userClient.rpc("api_add_member", {
      p_account_id: account.id,
      p_user_email: email,
      p_role: role,
    });

    if (error) {
      logError("api.v1.members.add", error, { account_id: account.id });
      return mapRpcError(error, origin, requestId, "No user with that email.");
    }

    const row = (data ?? {}) as {
      id?: string;
      account_id?: string;
      user_id?: string;
      role?: string;
      created_at?: string;
    };

    return apiJson(
      201,
      {
        id: row.id,
        account_id: row.account_id,
        user_id: row.user_id,
        role: row.role,
        created_at: row.created_at,
      },
      origin,
    );
  }

  return apiError(405, "method_not_allowed", `Method ${method} not allowed.`, origin, requestId);
});
