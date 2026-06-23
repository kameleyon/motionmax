/**
 * marginReconcile — per-job margin reconciliation on terminal success.
 *
 * Builder H (roadmap §1.3 G-M reconciliation): when a billed job completes,
 * we want a single, auditable number answering "did this job make money?".
 * We already charge credits up-front (gateway worst-rung quote or the
 * browser path's getCreditCost) and the worker writes real provider USD to
 * api_call_logs.cost via writeApiLog. This module joins the two:
 *
 *   chargedUsd  = creditsCharged × CREDIT_USD_RATE
 *   providerUsd = Σ api_call_logs.cost WHERE job_id = jobId
 *   margin      = chargedUsd − providerUsd
 *
 * and:
 *   (a) records a `api_job_margin_usd` gauge into a tiny in-process metrics
 *       registry (the worker has no prom-client dependency — its /metrics
 *       endpoint in healthServer.ts builds Prometheus text by hand, so we
 *       expose `getMarginMetrics()` for that surface to read on demand);
 *   (b) emits a structured WARNING when margin falls below a threshold
 *       (default: any negative margin, i.e. the job lost money), so margin
 *       erosion surfaces in the logs / Errors tab before it shows up in the
 *       monthly P&L.
 *
 * It is deliberately side-effect-only and NEVER throws: a reconciliation
 * read failure must not turn a successful job into a failed one. The caller
 * (worker terminal-success path in index.ts) fires it best-effort.
 */

import { supabase } from "./supabase.js";
import { wlog } from "./workerLogger.js";

/**
 * Dollar value of one MotionMax credit. MUST stay in sync with
 * api/v1/_shared/pricing.ts CREDIT_USD_RATE — the gateway prices credits at
 * this rate, so reconciliation has to value them identically or the margin
 * is meaningless. Mirrored (not imported) because api/ compiles under a
 * separate tsconfig with Deno-style imports the worker build can't resolve.
 */
export const CREDIT_USD_RATE = 0.03;

/**
 * Margin threshold (USD). A reconciled margin at or below this value emits a
 * structured warning. Default 0 → warn on any non-profitable job. Override
 * via MARGIN_WARN_THRESHOLD_USD (e.g. set to a small positive cushion to
 * catch thin-margin jobs before they go negative).
 */
const MARGIN_WARN_THRESHOLD_USD = (() => {
  const raw = process.env.MARGIN_WARN_THRESHOLD_USD;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
})();

export interface JobMarginResult {
  jobId: string;
  creditsCharged: number;
  chargedUsd: number;
  providerUsd: number;
  marginUsd: number;
  /** True when margin was at/below the warn threshold. */
  belowThreshold: boolean;
}

// ── In-process metrics registry ──────────────────────────────────────────
// The worker has no prom-client registry; healthServer.ts hand-builds the
// Prometheus exposition. We keep a small rolling snapshot here so that
// surface (or a test) can read the most recent margins without us reaching
// across module boundaries. Bounded to avoid unbounded memory growth.
interface MarginGaugeSample {
  jobId: string;
  marginUsd: number;
  chargedUsd: number;
  providerUsd: number;
  at: number; // epoch ms
}

const MAX_GAUGE_SAMPLES = 256;
const marginSamples: MarginGaugeSample[] = [];
let lastMarginUsd: number | null = null;
let reconciledJobsTotal = 0;
let negativeMarginJobsTotal = 0;
let cumulativeMarginUsd = 0;

function recordMarginGauge(sample: MarginGaugeSample): void {
  marginSamples.push(sample);
  if (marginSamples.length > MAX_GAUGE_SAMPLES) marginSamples.shift();
  lastMarginUsd = sample.marginUsd;
  reconciledJobsTotal += 1;
  cumulativeMarginUsd += sample.marginUsd;
  if (sample.marginUsd < 0) negativeMarginJobsTotal += 1;
}

/**
 * Snapshot of the margin metrics for the worker's /metrics surface (or a
 * test). `api_job_margin_usd` is the gauge for the most recently reconciled
 * job; the counters are process-lifetime totals.
 */
export function getMarginMetrics(): {
  /** Most-recent reconciled job margin (USD); null before any job reconciled. */
  api_job_margin_usd: number | null;
  api_jobs_reconciled_total: number;
  api_jobs_negative_margin_total: number;
  api_cumulative_margin_usd: number;
  samples: ReadonlyArray<MarginGaugeSample>;
} {
  return {
    api_job_margin_usd: lastMarginUsd,
    api_jobs_reconciled_total: reconciledJobsTotal,
    api_jobs_negative_margin_total: negativeMarginJobsTotal,
    api_cumulative_margin_usd: cumulativeMarginUsd,
    samples: marginSamples,
  };
}

/** Test-only reset of the in-process gauge state. */
export function __resetMarginMetricsForTest(): void {
  marginSamples.length = 0;
  lastMarginUsd = null;
  reconciledJobsTotal = 0;
  negativeMarginJobsTotal = 0;
  cumulativeMarginUsd = 0;
}

/**
 * Reconcile the margin for a completed job. Sums api_call_logs.cost for the
 * job, converts the charged credits to USD at CREDIT_USD_RATE, and records /
 * warns on the resulting margin. Best-effort and non-throwing.
 *
 * @param jobId          video_generation_jobs.id that just completed.
 * @param creditsCharged credits debited for this job at creation time.
 * @returns the reconciliation result, or null if it was skipped (no positive
 *          charge) or a read error prevented reconciliation.
 */
export async function reconcileJobMargin(
  jobId: string,
  creditsCharged: number,
): Promise<JobMarginResult | null> {
  try {
    // Nothing meaningful to reconcile for an unbilled / zero-charge job.
    if (!Number.isFinite(creditsCharged) || creditsCharged <= 0) return null;

    const { data, error } = await supabase
      .from("api_call_logs")
      .select("cost")
      .eq("job_id", jobId);

    if (error) {
      wlog.warn("Margin reconciliation read failed — skipping", {
        jobId,
        error: error.message,
      });
      return null;
    }

    const providerUsd = (data ?? []).reduce((sum, row) => {
      const raw = (row as { cost: unknown }).cost;
      const c = typeof raw === "number" ? raw : Number(raw);
      return sum + (Number.isFinite(c) && c > 0 ? c : 0);
    }, 0);

    const chargedUsd = creditsCharged * CREDIT_USD_RATE;
    const marginUsd = chargedUsd - providerUsd;
    const belowThreshold = marginUsd <= MARGIN_WARN_THRESHOLD_USD;

    recordMarginGauge({
      jobId,
      marginUsd,
      chargedUsd,
      providerUsd,
      at: Date.now(),
    });

    const fields = {
      jobId,
      creditsCharged,
      chargedUsd: Number(chargedUsd.toFixed(4)),
      providerUsd: Number(providerUsd.toFixed(4)),
      marginUsd: Number(marginUsd.toFixed(4)),
      thresholdUsd: MARGIN_WARN_THRESHOLD_USD,
      metric: "api_job_margin_usd",
    };

    if (belowThreshold) {
      wlog.warn(
        marginUsd < 0
          ? "Job margin NEGATIVE — provider spend exceeded credits charged"
          : "Job margin below warn threshold",
        fields,
      );
    } else {
      wlog.info("Job margin reconciled", fields);
    }

    return {
      jobId,
      creditsCharged,
      chargedUsd,
      providerUsd,
      marginUsd,
      belowThreshold,
    };
  } catch (err) {
    // Never let reconciliation failure escape into the job lifecycle.
    wlog.warn("Margin reconciliation threw — ignored", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
