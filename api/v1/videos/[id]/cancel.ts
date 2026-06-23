// MotionMax Public API — POST /api/v1/videos/{id}/cancel
//
// Cancels an in-flight video job and (for billed live jobs) issues a
// cost-aware refund.
//
// Auth:        requireApiKey() (throws a Response on failure — returned verbatim).
// Owner:       the job's account_id MUST equal the authenticated key's
//              account.id, else 404 not_found (never 403 — don't leak existence).
// Transition:  only jobs in ('pending','processing') flip to status='cancelled'
//              with error_message='Cancelled via API'. Already-terminal jobs are
//              idempotent: we return their current public state without mutating.
// Refund:      live (env='live') jobs that were billed (billed_at set) get a
//              cost-aware refund via costAwareRefund() — refund =
//              charged − provider_cost_incurred (roadmap §4(a) rec 3). Test-env
//              jobs spend no credits, so they are never refunded.

import { webHandler } from "../../../_shared/webHandler";
import { handlePreflight } from "../../../_shared/cors";
import { logError } from "../../../_shared/platformConfig";
import { requireApiKey } from "../../../_shared/apiKeyAuth";
import { costAwareRefund } from "../../_shared/refund";
import {
  apiError,
  apiJson,
  newRequestId,
  mapInternalToPublicState,
  TERMINAL_PUBLIC_STATES,
  type ApiJobView,
  type VideoMode,
} from "../../_shared/contract";

/**
 * Minimal shape of the internal job row this handler reads/mutates via the
 * service-role client.
 */
interface JobRow {
  id: string;
  account_id: string | null;
  user_id: string | null;
  api_key_id: string | null;
  task_type: string | null;
  status: string | null;
  error_message: string | null;
  created_at: string | null;
  billed_at: string | null;
  payload: Record<string, unknown> | null;
}

const CANCELLABLE_INTERNAL = new Set<string>(["pending", "processing"]);
const CANCEL_MESSAGE = "Cancelled via API";

/** Extract the `[id]` route segment from `/api/v1/videos/<id>/cancel`. */
function extractId(req: Request): string | null {
  try {
    const { pathname } = new URL(req.url);
    const segments = pathname.split("/").filter(Boolean);
    const idx = segments.lastIndexOf("videos");
    if (idx >= 0 && idx + 1 < segments.length) {
      return decodeURIComponent(segments[idx + 1]);
    }
    return null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export default webHandler(async (req: Request): Promise<Response> => {
  const pf = handlePreflight(req);
  if (pf) return pf;
  const origin = req.headers.get("origin");
  const requestId = newRequestId();

  if (req.method !== "POST") {
    return apiError(405, "method_not_allowed", "Use POST to cancel a video.", origin, requestId);
  }

  try {
    const { account, apiKey, supabase } = await requireApiKey(req);

    const id = extractId(req);
    if (!id) {
      return apiError(404, "not_found", "Video not found.", origin, requestId);
    }

    const { data, error } = await supabase
      .from("video_generation_jobs")
      .select(
        "id, account_id, user_id, api_key_id, task_type, status, error_message, created_at, billed_at, payload",
      )
      .eq("id", id)
      .maybeSingle();

    if (error) {
      logError("api.v1.videos.cancel.query_failed", error, { requestId, id });
      return apiError(500, "internal_error", "Failed to load video.", origin, requestId);
    }

    let row = data as JobRow | null;

    // Owner check by account_id. Missing OR foreign-account rows → 404.
    if (!row || row.account_id !== account.id) {
      return apiError(404, "not_found", "Video not found.", origin, requestId);
    }

    const mode =
      (asString((row.payload ?? {}).mode) as VideoMode | null) ?? row.task_type ?? "unknown";

    const currentPublic = mapInternalToPublicState(row.status, row.error_message);

    // Idempotent: already-terminal jobs return their current state untouched.
    if (TERMINAL_PUBLIC_STATES.has(currentPublic)) {
      const view: ApiJobView = {
        id: row.id,
        object: "video",
        status: currentPublic,
        mode,
        created_at: row.created_at ?? new Date().toISOString(),
        result: null,
      };
      return apiJson(200, view, origin);
    }

    // Live transition: flip pending/processing → cancelled. The status guard on
    // the UPDATE makes this safe against a concurrent worker terminal write —
    // if the worker wins, rowCount is 0 and we re-read the authoritative state.
    if (row.status && CANCELLABLE_INTERNAL.has(row.status)) {
      const { data: updated, error: updateErr } = await supabase
        .from("video_generation_jobs")
        .update({
          status: "cancelled",
          error_message: CANCEL_MESSAGE,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .in("status", ["pending", "processing"])
        .select(
          "id, account_id, user_id, api_key_id, task_type, status, error_message, created_at, billed_at, payload",
        )
        .maybeSingle();

      if (updateErr) {
        logError("api.v1.videos.cancel.update_failed", updateErr, { requestId, id: row.id });
        return apiError(500, "internal_error", "Failed to cancel video.", origin, requestId);
      }

      if (updated) {
        // We won the race and flipped the row to cancelled.
        row = updated as JobRow;

        // Cost-aware refund: only live, billed jobs. Test-env jobs spend no
        // credits. Refund is best-effort — a refund failure must NOT make the
        // cancel itself appear to fail, so we log and continue.
        if (apiKey.env === "live" && row.billed_at && row.user_id) {
          try {
            // Credits originally charged were stamped on the payload at create
            // time (videos/index.ts). Without it the cost-aware refund has no
            // baseline and would refund nothing.
            const chargedRaw = (row.payload ?? {})["credits_charged"];
            const charged =
              typeof chargedRaw === "number" ? chargedRaw : Number(chargedRaw) || 0;
            await costAwareRefund(supabase, {
              jobId: row.id,
              userId: row.user_id,
              accountId: account.id,
              charged,
            });
          } catch (refundErr) {
            logError("api.v1.videos.cancel.refund_failed", refundErr, {
              requestId,
              id: row.id,
            });
          }
        }
      } else {
        // Lost the race: a worker terminal write landed first. Re-read the
        // authoritative row so we report its real state, not a stale guess.
        const { data: fresh } = await supabase
          .from("video_generation_jobs")
          .select("id, status, error_message, created_at")
          .eq("id", row.id)
          .maybeSingle();
        if (fresh) {
          row = { ...row, ...(fresh as Partial<JobRow>) } as JobRow;
        }
      }
    }

    const finalPublic = mapInternalToPublicState(row.status, row.error_message);
    const view: ApiJobView = {
      id: row.id,
      object: "video",
      status: finalPublic,
      mode,
      created_at: row.created_at ?? new Date().toISOString(),
      result: null,
    };

    return apiJson(200, view, origin);
  } catch (e) {
    if (e instanceof Response) return e;
    logError("api.v1.videos.cancel.unhandled", e, { requestId });
    return apiError(500, "internal_error", "Unexpected error.", origin, requestId);
  }
});
