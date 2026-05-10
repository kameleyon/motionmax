/**
 * refundCreditsOnFailure — credits refund logic for failed video generation jobs.
 *
 * Extracted from worker/src/index.ts (Probe F-10-02 / B-NEW-20) so unit tests
 * can import the REAL implementation without booting the rest of the worker
 * process (health server, autopost dispatchers, newsletter sender, etc.).
 *
 * The behaviour is unchanged from the previous in-place definition. See
 * worker/src/refundCreditsOnFailure.test.ts for the contract being enforced.
 */

import { supabase } from "./lib/supabase.js";
import { writeSystemLog } from "./lib/logger.js";
import type { Job } from "./types/job.js";

// 1 credit = 1 second. Multipliers: standard 1x, cinematic 5x, smartflow 0.5x
export const LENGTH_SECONDS: Record<string, number> = {
  short: 150,
  brief: 280,
  presentation: 360,
};
export const PRODUCT_MULT: Record<string, number> = {
  doc2video: 1,
  smartflow: 0.5,
  cinematic: 5,
};

export function getCreditCost(projectType: string, length: string): number {
  const secs = LENGTH_SECONDS[length] || 150;
  const mult = PRODUCT_MULT[projectType] || 1;
  return Math.ceil(secs * mult);
}

// Task types that ARE the credit-deduction point. Everything else
// (delivery, finalize, export, voice preview, etc.) is a downstream
// step funded by an upstream deduction, so a failure should NOT
// trigger a refund here. The 2026-05-08 incident: autopost_email_
// delivery failed because of a stale orchestrator + missing finalUrl,
// and the refund handler happily reimbursed 280 credits as if the
// generation itself had failed.
export const REFUNDABLE_TASK_TYPES = new Set<string>([
  "generate_video",
  "generate_cinematic",
  "autopost_render", // gated further below by creditsDeducted check
]);

export async function refundCreditsOnFailure(job: Job): Promise<void> {
  if (!job.user_id) {
    console.log(`[Refund] Skipping refund for job ${job.id} - no user_id`);
    return;
  }
  if (!REFUNDABLE_TASK_TYPES.has(job.task_type as string)) {
    console.log(
      `[Refund] Skipping refund for job ${job.id} — task_type "${job.task_type}" is downstream-only (not a credit-deduction point).`
    );
    return;
  }

  try {
    const payload = job.payload || {};
    const projectType = payload.projectType || "doc2video";
    const length = payload.length || "brief";

    // Autopost-specific guards.
    if ((job.task_type as string) === "autopost_render") {
      const deducted =
        typeof payload.creditsDeducted === "number" && payload.creditsDeducted > 0
          ? payload.creditsDeducted
          : 0;
      if (deducted === 0) {
        console.log(
          `[Refund] Skipping autopost refund for job ${job.id} — no creditsDeducted on payload (pre-deduction row)`
        );
        return;
      }
      // 2026-05-08 incident: a duplicate autopost_render row failed
      // (idempotence gate threw because the run was already complete).
      // The original render had already consumed the credits and
      // delivered. Refunding the duplicate would credit the user a
      // second time. Look at the autopost_run state — if it's already
      // 'rendered' / 'completed' / 'publishing', the credits were
      // consumed by a successful sibling render; skip refund.
      const runId = (payload as { autopost_run_id?: string }).autopost_run_id;
      if (typeof runId === "string") {
        const { data: runRow } = await supabase
          .from("autopost_runs")
          .select("status, video_job_id")
          .eq("id", runId)
          .maybeSingle();
        const status = (
          runRow as { status?: string; video_job_id?: string | null } | null
        )?.status;
        const finishedStates = new Set(["rendered", "publishing", "completed"]);
        if (
          status &&
          (finishedStates.has(status) ||
            (runRow as { video_job_id?: string | null } | null)?.video_job_id)
        ) {
          console.log(
            `[Refund] Skipping refund for job ${job.id} — autopost_run ${runId} already in status '${status}' (sibling render already consumed credits).`
          );
          return;
        }
      }
    }

    // Use the exact amount deducted upfront when available (stored in payload
    // by the edge function). Falls back to the formula estimate for legacy jobs
    // where the payload doesn't carry creditsDeducted.
    const creditsToRefund: number =
      typeof payload.creditsDeducted === "number" && payload.creditsDeducted > 0
        ? payload.creditsDeducted
        : getCreditCost(projectType, length);

    // Idempotency check: query credit_transactions for an existing refund row for
    // this job. Retried jobs transition back to 'processing' before failing again,
    // so a job-status check is unreliable — only a committed transaction record is.
    const refundDescription = `Refund for failed generation (job ${job.id})`;
    const { data: existingRefund, error: refundCheckError } = await supabase
      .from("credit_transactions")
      .select("id")
      .eq("user_id", job.user_id)
      .eq("transaction_type", "refund")
      .eq("description", refundDescription)
      .limit(1)
      .maybeSingle();

    if (refundCheckError) {
      console.warn(
        `[Refund] Could not verify idempotency for job ${job.id}:`,
        refundCheckError.message
      );
      // Fall through and attempt the refund; the RPC handles balance safely.
    } else if (existingRefund) {
      console.warn(
        `[Refund] Refund already issued for job ${job.id} (tx ${
          (existingRefund as { id: string }).id
        }) — skipping duplicate`
      );
      return;
    }

    console.log(
      `[Refund] Attempting to refund ${creditsToRefund} credits for user ${job.user_id} (job ${job.id}, type ${projectType}/${length})`
    );

    const { data: refundSuccess, error: rpcError } = await supabase.rpc(
      "refund_credits_securely",
      {
        p_user_id: job.user_id,
        p_amount: creditsToRefund,
        p_description: refundDescription,
      }
    );

    if (rpcError || !refundSuccess) {
      console.error(
        `[Refund] Failed to refund credits for user ${job.user_id}:`,
        rpcError?.message
      );
      await writeSystemLog({
        jobId: job.id,
        projectId: job.project_id ?? undefined,
        userId: job.user_id,
        category: "system_warning",
        eventType: "refund_failed",
        message: `Failed to refund ${creditsToRefund} credits for job ${job.id}`,
        details: { error: rpcError?.message },
      });
    } else {
      console.log(
        `[Refund] Successfully refunded ${creditsToRefund} credits for user ${job.user_id}`
      );
      await writeSystemLog({
        jobId: job.id,
        projectId: job.project_id ?? undefined,
        userId: job.user_id,
        category: "system_info",
        eventType: "credits_refunded",
        message: `Refunded ${creditsToRefund} credits for failed job ${job.id}`,
        details: { credits: creditsToRefund, projectType, length },
      });
    }
  } catch (err) {
    console.error(
      `[Refund] Exception while refunding credits for job ${job.id}:`,
      err
    );
  }
}
