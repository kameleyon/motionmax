// MotionMax Public API — cost-aware refund (api/v1).
//
// Implements roadmap §4(a) recommendation 3: "Cost-aware refunds for API jobs."
// Full-refund-on-failure is an abuse vector — a cinematic that fails at the
// FINAL video rung has already burned LLM + images + earlier clips, yet a naive
// refund returns 100%. Instead we refund only the UNSPENT portion:
//
//   refund = charged − provider_cost_incurred (in credits), clamped to [0, charged]
//
// provider_cost_incurred is the sum of api_call_logs.cost (raw USD, written by
// the worker's writeApiLog) for the job, converted to credits at CREDIT_USD_RATE.
//
// This is a pure helper: it performs the read + the refund RPC and returns the
// outcome. The worker (Builder H) wires it into the failure path. It does NOT
// decide WHEN to refund — only HOW MUCH.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CREDIT_USD_RATE } from "./pricing";

export interface CostAwareRefundInput {
  /** video_generation_jobs.id whose provider spend to reconcile. */
  jobId: string;
  /** Owner user to credit (refund_credits_securely.p_user_id). */
  userId: string;
  /** Owning account (for audit/log correlation only; not passed to the RPC). */
  accountId: string;
  /** Credits originally charged for this job at creation time. */
  charged: number;
}

export interface CostAwareRefundResult {
  /** True when the refund RPC (or no-op zero refund) completed without error. */
  ok: boolean;
  /** Credits actually refunded (0 when fully consumed or charged ≤ 0). */
  refunded: number;
  /** Provider USD summed from api_call_logs.cost for the job. */
  providerCostUsd: number;
  /** Provider cost expressed in credits (rounded up, the amount withheld). */
  providerCostCredits: number;
  /** Populated when the refund could not be completed. */
  error?: string;
}

/**
 * Compute and apply a cost-aware refund for a failed/cancelled API job.
 *
 * Refund = charged − ceil(sum(api_call_logs.cost for job) / CREDIT_USD_RATE),
 * clamped to [0, charged]. We round the withheld provider cost UP so we never
 * refund spend we actually incurred. A zero refund still returns ok:true (the
 * job legitimately consumed its whole charge) without calling the RPC.
 */
export async function costAwareRefund(
  supabase: SupabaseClient,
  { jobId, userId, accountId, charged }: CostAwareRefundInput,
): Promise<CostAwareRefundResult> {
  // Idempotency: a committed cost-aware refund row for this job means a sibling
  // path already refunded it — either this cancel handler racing the worker, or
  // the worker's failure branch (worker/src/lib/apiJobRefund.ts). BOTH paths
  // write the canonical description prefix `API job <id> cost-aware refund` and
  // both pre-check it here, so whichever commits second skips. (A simultaneous
  // sub-ms double-execution is closed at GA by a DB-level uniqueness constraint;
  // see remaining_for_ga.)
  const { data: priorRefund } = await supabase
    .from("credit_transactions")
    .select("id")
    .eq("user_id", userId)
    .eq("transaction_type", "refund")
    .ilike("description", `API job ${jobId} cost-aware refund%`)
    .limit(1)
    .maybeSingle();
  if (priorRefund) {
    return { ok: true, refunded: 0, providerCostUsd: 0, providerCostCredits: 0 };
  }

  // Sum the real provider USD attributed to this job.
  const { data, error: readError } = await supabase
    .from("api_call_logs")
    .select("cost")
    .eq("job_id", jobId);

  if (readError) {
    return {
      ok: false,
      refunded: 0,
      providerCostUsd: 0,
      providerCostCredits: 0,
      error: `failed to read api_call_logs for job ${jobId}: ${readError.message}`,
    };
  }

  const providerCostUsd = (data ?? []).reduce((sum, row) => {
    const raw = (row as { cost: unknown }).cost;
    const c = typeof raw === "number" ? raw : Number(raw) || 0;
    return sum + (Number.isFinite(c) && c > 0 ? c : 0);
  }, 0);

  // Convert incurred USD → credits, rounding UP so we withhold at least what
  // we spent (never refund spent money).
  const providerCostCredits = Math.ceil(providerCostUsd / CREDIT_USD_RATE);

  const safeCharged = Number.isFinite(charged) && charged > 0 ? charged : 0;
  const refund = Math.max(0, Math.min(safeCharged, safeCharged - providerCostCredits));

  // Nothing to give back: the job consumed its whole charge (or wasn't charged).
  if (refund <= 0) {
    return {
      ok: true,
      refunded: 0,
      providerCostUsd,
      providerCostCredits,
    };
  }

  // Canonical prefix `API job <id> cost-aware refund` — MUST match the worker's
  // idempotency guard in worker/src/lib/apiJobRefund.ts (account moved after the
  // prefix so the cross-path ilike checks see each other).
  const description =
    `API job ${jobId} cost-aware refund (account ${accountId}): ` +
    `charged ${safeCharged}, provider cost ${providerCostCredits} cr ` +
    `($${providerCostUsd.toFixed(4)}), refunded ${refund}`;

  const { error: rpcError } = await supabase.rpc("refund_credits_securely", {
    p_user_id: userId,
    p_amount: refund,
    p_description: description,
  });

  if (rpcError) {
    return {
      ok: false,
      refunded: 0,
      providerCostUsd,
      providerCostCredits,
      error: `refund_credits_securely failed for job ${jobId}: ${rpcError.message}`,
    };
  }

  return {
    ok: true,
    refunded: refund,
    providerCostUsd,
    providerCostCredits,
  };
}
