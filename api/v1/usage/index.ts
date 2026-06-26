/**
 * GET /api/v1/usage — tenant-scoped usage & spend for the calling API key's
 * account (roadmap Phase 3 §"Public usage API": balance, per-period spend,
 * per-call cost breakdown).
 *
 * Authenticates with a customer API key (`requireApiKey`) and reports usage for
 * the SINGLE account that key belongs to. Cost is attributed via
 * api_call_logs.job_id → video_generation_jobs.account_id (api_usage_summary /
 * api_spend_breakdown own that join). Always returns the current wallet balance
 * plus a 30-day (default) summary; when `?group_by=` is present it also returns
 * a per-provider / per-model / per-day breakdown.
 *
 * Query params:
 *   since      — optional ISO-8601 timestamp; window start (default: now − 30d).
 *   group_by   — optional 'provider' | 'model' | 'day'; when present, include
 *                a `breakdown` array. Omitted → summary only.
 *
 * Tenant safety: these RPCs are called with the service-role client, for which
 * api_assert_account_owner is bypassed (auth.uid() is NULL). Scoping is enforced
 * by passing the AUTHENTICATED account.id from requireApiKey, never a
 * client-supplied id — so a caller can only ever read their own account.
 */

import { webHandler } from "../../_shared/webHandler";
import { handlePreflight } from "../../_shared/cors";
import { logError } from "../../_shared/platformConfig";
import { isResponse } from "../../_shared/auth";
import { requireApiKey } from "../../_shared/apiKeyAuth";
import {
  apiError,
  apiJson,
  newRequestId,
  type ApiKeyAuthOk,
} from "../_shared/contract";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const VALID_GROUP_BY: ReadonlySet<string> = new Set(["provider", "model", "day"]);

// Shape of api_usage_summary's jsonb return (mirrors the RPC).
interface UsageSummary {
  calls: number;
  total_cost_usd: number;
  jobs: number;
  credits_balance: number;
  since: string;
}

// Shape of one api_spend_breakdown row.
interface SpendBreakdownRow {
  label: string;
  calls: number;
  spend: number;
  avg_ms: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — usage summary (+ optional breakdown).
// ─────────────────────────────────────────────────────────────────────────────

async function handleUsage(
  req: Request,
  auth: ApiKeyAuthOk,
  origin: string | null,
  requestId: string,
): Promise<Response> {
  const { account, supabase } = auth;

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return apiError(400, "invalid_request", "Unparseable request URL.", origin, requestId);
  }

  // since — optional ISO timestamp. Reject garbage so the caller gets a clear
  // 400 rather than a silently-defaulted window.
  let since: string | undefined;
  const sinceParam = url.searchParams.get("since");
  if (sinceParam !== null) {
    const ts = new Date(sinceParam);
    if (Number.isNaN(ts.getTime())) {
      return apiError(400, "invalid_request", "`since` must be an ISO-8601 timestamp.", origin, requestId);
    }
    since = ts.toISOString();
  }

  // group_by — optional; when present, gate to the supported dimensions.
  const groupBy = url.searchParams.get("group_by");
  if (groupBy !== null && !VALID_GROUP_BY.has(groupBy)) {
    return apiError(
      400,
      "invalid_request",
      "`group_by` must be one of: provider, model, day.",
      origin,
      requestId,
    );
  }

  // 1) Summary (always). Pass the AUTHENTICATED account id — never a client value.
  const summaryArgs: { p_account_id: string; p_since?: string } = {
    p_account_id: account.id,
  };
  if (since) summaryArgs.p_since = since;

  const { data: summaryData, error: summaryErr } = await supabase.rpc(
    "api_usage_summary",
    summaryArgs,
  );

  if (summaryErr) {
    logError("api.v1.usage.summary", summaryErr, { requestId });
    return apiError(500, "internal_error", "Failed to load usage.", origin, requestId);
  }

  const summary = (summaryData ?? {}) as UsageSummary;

  const body: {
    object: "usage";
    account_id: string;
    since: string | null;
    calls: number;
    jobs: number;
    total_cost_usd: number;
    credits_balance: number;
    breakdown?: SpendBreakdownRow[];
  } = {
    object: "usage",
    account_id: account.id,
    since: summary.since ?? since ?? null,
    calls: summary.calls ?? 0,
    jobs: summary.jobs ?? 0,
    total_cost_usd: summary.total_cost_usd ?? 0,
    credits_balance: summary.credits_balance ?? 0,
  };

  // 2) Breakdown (only when ?group_by= is supplied).
  if (groupBy !== null) {
    const breakdownArgs: { p_account_id: string; p_group_by: string; p_since?: string } = {
      p_account_id: account.id,
      p_group_by: groupBy,
    };
    if (since) breakdownArgs.p_since = since;

    const { data: rows, error: breakdownErr } = await supabase.rpc(
      "api_spend_breakdown",
      breakdownArgs,
    );

    if (breakdownErr) {
      logError("api.v1.usage.breakdown", breakdownErr, { requestId });
      return apiError(500, "internal_error", "Failed to load the spend breakdown.", origin, requestId);
    }

    body.breakdown = (rows ?? []) as SpendBreakdownRow[];
  }

  return apiJson(200, body, origin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrypoint.
// ─────────────────────────────────────────────────────────────────────────────

export default webHandler(async (req: Request): Promise<Response> => {
  const pf = handlePreflight(req);
  if (pf) return pf;

  const origin = req.headers.get("origin");
  const requestId = newRequestId();
  const method = (req.method || "GET").toUpperCase();

  if (method !== "GET") {
    return apiError(405, "method_not_allowed", `Method ${method} is not allowed.`, origin, requestId);
  }

  // Authenticate — requireApiKey throws a Response on failure.
  let auth: ApiKeyAuthOk;
  try {
    auth = await requireApiKey(req);
  } catch (e) {
    if (isResponse(e)) return e;
    logError("api.v1.usage.auth", e, { requestId });
    return apiError(500, "internal_error", "Authentication failed.", origin, requestId);
  }

  try {
    return await handleUsage(req, auth, origin, requestId);
  } catch (e) {
    if (isResponse(e)) return e;
    logError("api.v1.usage.handler", e, { requestId });
    return apiError(500, "internal_error", "An unexpected error occurred.", origin, requestId);
  }
});
