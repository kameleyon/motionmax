// MotionMax Public API — /api/v1/keys/{id} (item)
//
//   POST   /api/v1/keys/{id}  — rotate the key (mint a new secret, retire old).
//   DELETE /api/v1/keys/{id}  — revoke the key.
//
// Auth: requireUser() (browser/JWT caller) — the dashboard drives key lifecycle.
// requireUser throws a Response on failure, returned verbatim via isResponse(e).
//
// Ownership: api_rotate_key / api_revoke_key assert ownership INTERNALLY via
// api_assert_account_owner() (auth.uid()), so they MUST be called through the
// JWT-scoped `userClient`. On a foreign or unknown id the RPC raises rather than
// returning a row; we map that to 404 not_found (never 403) so the endpoint
// never leaks the existence of another tenant's key.

import { webHandler } from "../../../_shared/webHandler";
import { handlePreflight } from "../../../_shared/cors";
import { logError } from "../../../_shared/platformConfig";
import { isResponse } from "../../../_shared/auth";
import { requireUser } from "../../../_shared/userAuth";
import { apiError, apiJson, newRequestId } from "../../_shared/contract";

/** Extract the `{id}` route segment (the path part after `keys`). */
function extractId(req: Request): string | null {
  try {
    const { pathname } = new URL(req.url);
    const segments = pathname.split("/").filter(Boolean);
    // .../api/v1/keys/<id>  → <id> is the segment right after "keys".
    const idx = segments.lastIndexOf("keys");
    if (idx >= 0 && idx + 1 < segments.length) {
      return decodeURIComponent(segments[idx + 1]);
    }
    return null;
  } catch {
    return null;
  }
}

export default webHandler(async (req): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const origin = req.headers.get("origin");
  const requestId = newRequestId();
  const method = (req.method || "GET").toUpperCase();

  const id = extractId(req);
  if (!id) {
    return apiError(400, "invalid_request", "Missing key id in path.", origin, requestId);
  }

  // Authenticate the browser/JWT caller and resolve their account.
  let auth;
  try {
    auth = await requireUser(req);
  } catch (e) {
    if (isResponse(e)) return e;
    logError("api.v1.keys.id.requireUser", e);
    return apiError(500, "internal_error", "Authentication failed.", origin, requestId);
  }
  const { userClient } = auth;

  // ── POST: rotate ───────────────────────────────────────────────────────────
  if (method === "POST") {
    const { data, error } = await userClient.rpc("api_rotate_key", { p_id: id });

    if (error) {
      // Ownership/existence failures raise inside the RPC. Map to 404 so we
      // never confirm whether the id exists for another tenant.
      logError("api.v1.keys.id.rotate", error, { key_id: id });
      return apiError(404, "not_found", "API key not found.", origin, requestId);
    }

    const row = (data ?? {}) as {
      rotated_id?: string;
      id?: string;
      token?: string;
      prefix?: string;
      last4?: string;
      env?: string;
    };

    // NOTE: `token` is the PLAINTEXT key for the freshly-minted credential and
    // is returned here ONE TIME ONLY — it is never surfaced again.
    return apiJson(
      200,
      {
        id: row.id,
        rotated_id: row.rotated_id,
        prefix: row.prefix,
        last4: row.last4,
        env: row.env,
        token: row.token,
      },
      origin,
    );
  }

  // ── DELETE: revoke ─────────────────────────────────────────────────────────
  if (method === "DELETE") {
    const { error } = await userClient.rpc("api_revoke_key", { p_id: id });

    if (error) {
      logError("api.v1.keys.id.revoke", error, { key_id: id });
      return apiError(404, "not_found", "API key not found.", origin, requestId);
    }

    return apiJson(200, { id, status: "revoked" }, origin);
  }

  return apiError(405, "method_not_allowed", `Method ${method} not allowed.`, origin, requestId);
});
