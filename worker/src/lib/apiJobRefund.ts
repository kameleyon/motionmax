/**
 * apiJobRefund — cost-aware refund for FAILED /api/v1 gateway jobs.
 *
 * Why a worker-side twin of api/v1/_shared/refund.ts: the worker compiles under
 * its own tsconfig and cannot import the api/ tree (separate module resolution,
 * Deno-style imports). So the cost-aware refund logic is mirrored here for the
 * worker's terminal-FAILURE path. The credit↔USD rate is the ONE shared input
 * and is imported from marginReconcile (CREDIT_USD_RATE) so both halves agree.
 *
 * Roadmap §4(a) rec 3: a full refund on a late failure is an abuse vector — a
 * cinematic that fails at the FINAL video rung has already burned LLM + images +
 * earlier clips. refundCreditsOnFailure (the browser path) would either skip API
 * task_types entirely (zero refund) or, if they were added to its set, refund
 * 100%. Neither is correct. We refund only the UNSPENT portion:
 *
 *   refund = charged − ceil( Σ api_call_logs.cost / CREDIT_USD_RATE )  clamped [0, charged]
 */

import { supabase } from "./supabase.js";
import { writeSystemLog } from "./logger.js";
import { CREDIT_USD_RATE } from "./marginReconcile.js";
import type { Job } from "../types/job.js";

/** True when the job originated from the public /api/v1 gateway. */
export function isApiJob(job: Job): boolean {
  const payload = job.payload as { source?: unknown } | null | undefined;
  return !!payload && (payload as { source?: unknown }).source === "api_v1";
}

/**
 * Compute + apply a cost-aware refund for a failed API job. Best-effort and
 * non-throwing — a refund failure must never escape into the job lifecycle.
 * Idempotent: skips if a cost-aware refund row already exists for this job.
 */
export async function costAwareRefundApiJob(job: Job): Promise<void> {
  if (!job.user_id) return;

  const payload = (job.payload || {}) as Record<string, unknown>;
  const chargedRaw = payload.credits_charged ?? payload.creditsDeducted;
  const charged =
    typeof chargedRaw === "number" && chargedRaw > 0 ? chargedRaw : 0;
  if (charged <= 0) {
    // Unbilled (sandbox or pre-deduction row) — nothing to refund.
    return;
  }

  const descriptionPrefix = `API job ${job.id} cost-aware refund`;

  try {
    // Idempotency: a committed refund row is the only reliable signal (retried
    // jobs cycle back through 'processing' before failing again).
    const { data: existing, error: existsErr } = await supabase
      .from("credit_transactions")
      .select("id")
      .eq("user_id", job.user_id)
      .eq("transaction_type", "refund")
      .ilike("description", `${descriptionPrefix}%`)
      .limit(1)
      .maybeSingle();

    if (!existsErr && existing) {
      console.log(
        `[ApiRefund] Refund already issued for job ${job.id} — skipping duplicate`,
      );
      return;
    }

    // Sum the real provider USD attributed to this job.
    const { data: logs, error: logErr } = await supabase
      .from("api_call_logs")
      .select("cost")
      .eq("job_id", job.id);

    if (logErr) {
      // Can't size the spend — abort rather than risk over-refunding.
      console.warn(
        `[ApiRefund] api_call_logs read failed for job ${job.id} — skipping refund:`,
        logErr.message,
      );
      return;
    }

    const providerUsd = (logs ?? []).reduce((sum, row) => {
      const raw = (row as { cost: unknown }).cost;
      const c = typeof raw === "number" ? raw : Number(raw);
      return sum + (Number.isFinite(c) && c > 0 ? c : 0);
    }, 0);

    // Withhold the incurred provider cost (rounded UP — never refund spent money).
    const providerCredits = Math.ceil(providerUsd / CREDIT_USD_RATE);
    const refund = Math.max(0, Math.min(charged, charged - providerCredits));

    if (refund <= 0) {
      console.log(
        `[ApiRefund] Job ${job.id} consumed its whole charge (charged ${charged}, provider ${providerCredits}cr) — no refund.`,
      );
      return;
    }

    const description =
      `${descriptionPrefix}: charged ${charged}, provider ${providerCredits}cr ` +
      `($${providerUsd.toFixed(4)}), refunded ${refund}`;

    const { data: ok, error: rpcErr } = await supabase.rpc(
      "refund_credits_securely",
      {
        p_user_id: job.user_id,
        p_amount: refund,
        p_description: description,
      },
    );

    if (rpcErr || !ok) {
      console.error(
        `[ApiRefund] refund_credits_securely failed for job ${job.id}:`,
        rpcErr?.message,
      );
      await writeSystemLog({
        jobId: job.id,
        projectId: job.project_id ?? undefined,
        userId: job.user_id,
        category: "system_warning",
        eventType: "refund_failed",
        message: `Cost-aware refund failed for API job ${job.id}`,
        details: { error: rpcErr?.message, charged, providerCredits, refund },
      });
      return;
    }

    console.log(
      `[ApiRefund] Refunded ${refund} credits for failed API job ${job.id} ` +
        `(charged ${charged}, withheld ${providerCredits} provider).`,
    );
    await writeSystemLog({
      jobId: job.id,
      projectId: job.project_id ?? undefined,
      userId: job.user_id,
      category: "system_info",
      eventType: "credits_refunded",
      message: `Cost-aware refund of ${refund} credits for failed API job ${job.id}`,
      details: { charged, providerCredits, providerUsd, refund },
    });
  } catch (err) {
    console.error(`[ApiRefund] Exception refunding API job ${job.id}:`, err);
  }
}
