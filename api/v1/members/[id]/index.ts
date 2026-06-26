// MotionMax Public API — /api/v1/members/{id} (item)
//
//   DELETE /api/v1/members/{id}  — remove a member ({id} is the member's
//                                  auth user_id). Owner/admin only.
//
// Auth: requireUser() (browser/JWT caller) — the dashboard drives team roster
// changes. requireUser throws a Response on failure, returned verbatim via
// isResponse(e), and resolves the caller's account (owner OR membership).
//
// api_remove_member asserts owner/admin rights INTERNALLY via
// api_assert_account_owner() (auth.uid()), so it MUST be called through the
// JWT-scoped `userClient`. It also rejects removing the LAST owner (Postgres
// 22023 → 400), and raises P0002 (→ 404) when no such membership exists.

import { webHandler } from "../../../_shared/webHandler";
import { handlePreflight } from "../../../_shared/cors";
import { logError } from "../../../_shared/platformConfig";
import { isResponse } from "../../../_shared/auth";
import { requireUser } from "../../../_shared/userAuth";
import { apiError, apiJson, newRequestId } from "../../_shared/contract";

/** Extract the `{id}` route segment (the part after `members`). */
function extractId(req: Request): string | null {
  try {
    const { pathname } = new URL(req.url);
    const segments = pathname.split("/").filter(Boolean);
    // .../api/v1/members/<id>  → <id> is the segment right after "members".
    const idx = segments.lastIndexOf("members");
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

  const userId = extractId(req);
  if (!userId) {
    return apiError(400, "invalid_request", "Missing member id in path.", origin, requestId);
  }

  let auth;
  try {
    auth = await requireUser(req);
  } catch (e) {
    if (isResponse(e)) return e;
    logError("api.v1.members.id.requireUser", e);
    return apiError(500, "internal_error", "Authentication failed.", origin, requestId);
  }
  const { account, userClient } = auth;

  // ── DELETE: remove a member ──────────────────────────────────────────────
  if (method === "DELETE") {
    const { error } = await userClient.rpc("api_remove_member", {
      p_account_id: account.id,
      p_user_id: userId,
    });

    if (error) {
      logError("api.v1.members.id.remove", error, { account_id: account.id, user_id: userId });
      if (error.code === "42501") {
        return apiError(403, "forbidden", "You do not have permission to manage this account's members.", origin, requestId);
      }
      if (error.code === "P0002") {
        return apiError(404, "not_found", "Membership not found.", origin, requestId);
      }
      if (error.code === "22023") {
        // Last-owner guard (or other domain rule).
        return apiError(400, "invalid_request", error.message ?? "Cannot remove this member.", origin, requestId);
      }
      return apiError(500, "internal_error", "The member could not be removed.", origin, requestId);
    }

    return apiJson(200, { account_id: account.id, user_id: userId, removed: true }, origin);
  }

  return apiError(405, "method_not_allowed", `Method ${method} not allowed.`, origin, requestId);
});
