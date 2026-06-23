// MotionMax Public API — Node-callable, Postgres-backed rate-limit middleware.
//
// The /api/v1 gateway runs as STATELESS Vercel (Node) functions, so per-key
// counters cannot live in process memory — the state is in Postgres. This
// module is the Node entry point the gateway calls after requireApiKey()
// succeeds. It maps the caller's tier+env to a quota (rateLimitConfig.ts),
// invokes the SECURITY DEFINER api_check_rate_limit() RPC (migration
// 20260524000400) for an atomic sliding-window decision, and returns the
// window's limit/remaining/reset (minute window) plus, when blocked, the
// retry-after delay. The gateway derives X-RateLimit-* / Retry-After headers
// from those fields.
//
// NOTE: this is the Node analogue of the Deno edge limiter
// (supabase/functions/_shared/rateLimit.ts). That one is Deno-only and cannot be
// imported here; the shared state is the public.rate_limits table + the RPC.
//
// FAIL-OPEN POLICY (deliberate, documented): if the RPC errors or returns an
// unexpected shape, we ADMIT the request and log a warning. Rationale: this is
// an availability-first v1 limiter; a Postgres blip should degrade rate limiting
// to "off", not take the whole API down with spurious 429s. The hard safety net
// is elsewhere — claim_pending_job enforces a hard per-tenant in-flight cap and
// credit/spend gating still applies — so a brief unlimited window cannot run up
// unbounded provider spend. Tighten to fail-closed only if abuse data warrants.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiKeyEnv } from "../v1/_shared/contract";
import { getRateLimits, type AccountTier } from "../v1/_shared/rateLimitConfig";

/**
 * Outcome of one rate-limit check. The gateway (api/v1/videos/index.ts) reads
 * these fields directly to build X-RateLimit-* / Retry-After headers and to
 * decide whether to 429. `reset` is a unix epoch (seconds) for the minute
 * window; `retryAfterSec` is 0 when allowed.
 *
 * `headers` is a pre-built convenience map of the same X-RateLimit-* values for
 * callers that prefer to merge rather than reconstruct them.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Minute-window cap (rpm) advertised to the client. */
  limit: number;
  /** Remaining requests in the current minute window. */
  remaining: number;
  /** Unix epoch (seconds) when the minute window next has room. */
  reset: number;
  /** Seconds to wait before retrying (0 when allowed). */
  retryAfterSec: number;
  /**
   * Ready-to-merge X-RateLimit-* (+ Retry-After when blocked) headers.
   * Optional: the gateway derives headers from the scalar fields itself, so a
   * caller constructing a defensive fallback result may omit this.
   */
  headers?: Record<string, string>;
}

/** Shape returned by the api_check_rate_limit RPC (jsonb). */
interface RpcResult {
  allowed: boolean;
  limit_minute: number;
  remaining_minute: number;
  limit_day: number;
  remaining_day: number;
  reset_minute_epoch: number;
  retry_after_seconds: number;
}

function isRpcResult(v: unknown): v is RpcResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.allowed === "boolean" &&
    typeof r.limit_minute === "number" &&
    typeof r.remaining_minute === "number" &&
    typeof r.reset_minute_epoch === "number" &&
    typeof r.retry_after_seconds === "number"
  );
}

/** Build the standard header map (minute window) + Retry-After when blocked. */
function buildHeaders(
  limit: number,
  remaining: number,
  reset: number,
  retryAfterSec: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(Math.max(0, remaining)),
    "X-RateLimit-Reset": String(Math.max(0, Math.floor(reset))),
  };
  if (retryAfterSec > 0) {
    headers["Retry-After"] = String(retryAfterSec);
    headers["X-RateLimit-Retry-After"] = String(retryAfterSec);
  }
  return headers;
}

/**
 * Check (and record) one request against the per-key sliding-window quota.
 *
 * @param supabase  Service-role client (the RPC is granted to service_role only).
 * @param apiKeyId  public.api_keys.id of the authenticated key.
 * @param tier      Owning account tier — selects the live quota.
 * @param env       Key environment — 'test' keys use the sandbox envelope.
 *                  Defaults to 'live'.
 *
 * On RPC error or a malformed response: FAIL OPEN (allowed:true) with a logged
 * warning and best-effort headers (see module-level policy note).
 */
export async function checkApiRateLimit(
  supabase: SupabaseClient,
  apiKeyId: string,
  tier: AccountTier | string,
  env: ApiKeyEnv = "live",
): Promise<RateLimitResult> {
  const { rpm, daily } = getRateLimits(tier, env);

  let data: unknown;
  let error: unknown;
  try {
    const res = await supabase.rpc("api_check_rate_limit", {
      p_api_key_id: apiKeyId,
      p_rpm: rpm,
      p_daily: daily,
    });
    data = res.data;
    error = res.error;
  } catch (e) {
    error = e;
  }

  if (error || !isRpcResult(data)) {
    // FAIL OPEN — never block the customer on a limiter malfunction.
    console.warn("[rateLimit] api_check_rate_limit failed; failing OPEN", {
      apiKeyId,
      tier,
      env,
      error:
        error instanceof Error
          ? error.message
          : error
            ? String((error as { message?: unknown }).message ?? error)
            : "malformed_rpc_result",
    });
    const reset = Math.floor(Date.now() / 1000) + 60;
    return {
      allowed: true,
      limit: rpm,
      remaining: rpm,
      reset,
      retryAfterSec: 0,
      headers: buildHeaders(rpm, rpm, reset, 0),
    };
  }

  const r = data as RpcResult;
  const retryAfterSec = r.allowed ? 0 : Math.max(1, Math.floor(r.retry_after_seconds));

  return {
    allowed: r.allowed,
    limit: r.limit_minute,
    remaining: r.remaining_minute,
    reset: Math.max(0, Math.floor(r.reset_minute_epoch)),
    retryAfterSec,
    headers: buildHeaders(
      r.limit_minute,
      r.remaining_minute,
      r.reset_minute_epoch,
      retryAfterSec,
    ),
  };
}
