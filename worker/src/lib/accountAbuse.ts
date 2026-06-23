/**
 * accountAbuse — worker-side helpers for the API abuse-escalation path.
 *
 * Two pieces, deliberately decoupled:
 *
 *   1. autoSuspendAccount() — the WRITE: best-effort, non-throwing call to the
 *      api_suspend_account(uuid, text) RPC (Builder-D migration
 *      20260524000500). Service-role only; the worker's supabase client carries
 *      the service key. Suspension is ENFORCED at gateway auth time
 *      (apiKeyAuth.ts → 403 account_suspended); this is the worker write that
 *      flips the flag. NEVER throws — a suspend failure must not derail a job.
 *
 *   2. shouldAutoSuspend() — the POLICY: a pure, unit-testable predicate that
 *      decides whether an account has earned auto-suspension from recent abuse
 *      signals. It is intentionally NOT wired into a hot path here. The job
 *      lifecycle must never mass-suspend on a transient spike; a FUTURE
 *      escalation job (periodic sweep) is expected to gather signals over a
 *      window and call shouldAutoSuspend() → autoSuspendAccount(). Exposing the
 *      predicate + RPC wrapper now lets that job be a thin orchestrator.
 *
 * POLICY (shouldAutoSuspend):
 *   Suspend when, inside the lookback window, an account accrued at least
 *   AUTO_SUSPEND_MIN_REJECTIONS moderation rejections AND those rejections are
 *   at least AUTO_SUSPEND_MIN_REJECTION_RATE of its total submissions in the
 *   window (so a high-volume legitimate tenant with a few rejections is not
 *   swept). already_suspended short-circuits to false (no double work). The
 *   thresholds are conservative on purpose — auto-suspend is a blunt instrument
 *   and a human/admin escalation is always preferable for borderline cases.
 */

import { wlog } from "./workerLogger.js";

/**
 * Minimal shape of the supabase client we use here. Kept structural (not the
 * full SupabaseClient generic) so callers can pass either the worker's shared
 * client or a test double without a type-arg mismatch. The RPC wrapper only
 * needs .rpc().
 */
export interface AbuseSupabaseLike {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

/** Result of an autoSuspendAccount attempt. Never throws; success=false on any error. */
export interface AutoSuspendResult {
  success: boolean;
  accountId: string;
  alreadySuspended?: boolean;
  error?: string;
}

/**
 * Best-effort suspend of an account via api_suspend_account RPC.
 * Non-throwing: returns {success:false, error} on any failure and logs it.
 */
export async function autoSuspendAccount(
  supabase: AbuseSupabaseLike,
  accountId: string,
  reason: string,
): Promise<AutoSuspendResult> {
  if (!accountId) {
    return { success: false, accountId: accountId || "", error: "missing accountId" };
  }
  const cleanReason =
    reason && reason.trim().length > 0 ? reason.trim() : "policy_violation";

  try {
    const { data, error } = await supabase.rpc("api_suspend_account", {
      p_account_id: accountId,
      p_reason: cleanReason,
    });

    if (error) {
      wlog.error("autoSuspendAccount: RPC failed", {
        accountId,
        reason: cleanReason,
        error: error.message,
      });
      return { success: false, accountId, error: error.message };
    }

    const row = (data || {}) as { already_suspended?: boolean };
    wlog.warn("autoSuspendAccount: account suspended", {
      accountId,
      reason: cleanReason,
      alreadySuspended: !!row.already_suspended,
    });
    return {
      success: true,
      accountId,
      alreadySuspended: !!row.already_suspended,
    };
  } catch (err) {
    const msg = (err as Error).message;
    wlog.error("autoSuspendAccount: threw", { accountId, reason: cleanReason, error: msg });
    return { success: false, accountId, error: msg };
  }
}

// ── Policy ───────────────────────────────────────────────────────────────────

/** Minimum moderation rejections inside the window to even consider suspension. */
export const AUTO_SUSPEND_MIN_REJECTIONS = 5;

/**
 * Minimum fraction of windowed submissions that must be rejections. Guards a
 * high-volume legitimate tenant from being swept on a handful of rejects.
 */
export const AUTO_SUSPEND_MIN_REJECTION_RATE = 0.5;

/** Abuse signals gathered (by a future escalation job) over a lookback window. */
export interface AbuseSignals {
  /** Moderation rejections (input or output screening) in the window. */
  moderationRejections: number;
  /** Total submissions in the same window (rejections + accepted). */
  totalSubmissions: number;
  /** Whether the account is already suspended (short-circuits to false). */
  alreadySuspended?: boolean;
}

/**
 * Pure policy predicate. Returns true iff the signals warrant auto-suspension.
 * No side effects, no I/O — unit-testable in isolation.
 */
export function shouldAutoSuspend(signals: AbuseSignals): boolean {
  if (!signals || signals.alreadySuspended) return false;

  const rejections = Number.isFinite(signals.moderationRejections)
    ? Math.max(0, Math.floor(signals.moderationRejections))
    : 0;
  const total = Number.isFinite(signals.totalSubmissions)
    ? Math.max(0, Math.floor(signals.totalSubmissions))
    : 0;

  if (rejections < AUTO_SUSPEND_MIN_REJECTIONS) return false;

  // rejections can exceed total only via bad input; clamp the rate to [0,1].
  const denom = Math.max(total, rejections);
  if (denom === 0) return false;
  const rate = rejections / denom;

  return rate >= AUTO_SUSPEND_MIN_REJECTION_RATE;
}
