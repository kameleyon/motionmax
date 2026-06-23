// MotionMax Public API — per-tier rate-limit configuration.
//
// Single source of truth for the request-rate quotas the /api/v1 gateway
// enforces via api/_shared/rateLimit.ts → api_check_rate_limit(). Limits are
// keyed by the owning account's tier (free | creator | studio). The key's env
// ('test' | 'live') is taken into account separately: sandbox/test keys get a
// dedicated, smaller envelope so a customer's CI/smoke traffic can't starve
// their own live quota and vice-versa.
//
// These are REQUEST-RATE limits (calls per minute / per day), distinct from the
// hard per-tenant in-flight CONCURRENCY cap enforced at claim time
// (claim_pending_job: free 2 / creator 5 / studio 12). A request can be admitted
// here yet still queue behind the concurrency cap.

import type { AccountRecord, ApiKeyEnv } from "./contract";

export type AccountTier = AccountRecord["tier"];

export interface RateLimits {
  /** Max requests in any trailing 60-second window. */
  rpm: number;
  /** Max requests in any trailing 24-hour window. */
  daily: number;
}

/**
 * Live-key per-tier quotas. Tuned conservatively for v1: generous enough for
 * normal integration traffic, low enough to blunt a runaway client or a leaked
 * key before it drains provider budget.
 */
const LIVE_LIMITS: Record<AccountTier, RateLimits> = {
  free:    { rpm: 20,  daily: 200 },
  creator: { rpm: 60,  daily: 2000 },
  studio:  { rpm: 120, daily: 20000 },
};

/**
 * Test/sandbox keys (mm_test_…) share one modest envelope regardless of tier.
 * Sandbox requests never touch a provider or spend credits, but they still
 * exercise the full validation/auth path, so they get their own bucket to keep
 * test load from competing with live load on the same account.
 */
const TEST_LIMITS: RateLimits = { rpm: 30, daily: 500 };

/**
 * Resolve the effective rate limits for a request.
 *
 * @param tier  Owning account tier (defaults to the most conservative, 'free',
 *              for any unrecognized value).
 * @param env   Key environment. 'test' keys get the dedicated sandbox envelope;
 *              'live' keys get the tier-scoped quota.
 */
export function getRateLimits(tier: AccountTier | string, env: ApiKeyEnv): RateLimits {
  if (env === "test") {
    return TEST_LIMITS;
  }
  switch (tier) {
    case "studio":
      return LIVE_LIMITS.studio;
    case "creator":
      return LIVE_LIMITS.creator;
    case "free":
      return LIVE_LIMITS.free;
    default:
      return LIVE_LIMITS.free;
  }
}
