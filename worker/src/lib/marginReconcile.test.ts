/**
 * Tests for reconcileJobMargin (Builder H — margin reconciliation).
 *
 * Contract:
 *   1. margin = creditsCharged × CREDIT_USD_RATE − Σ api_call_logs.cost.
 *   2. A negative margin emits a warning + records the api_job_margin_usd gauge.
 *   3. A zero/negative creditsCharged is a no-op (returns null, no gauge).
 *   4. A DB read error is swallowed (returns null, never throws).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./supabase.js", () => {
  const supabase = { from: vi.fn() };
  return { supabase };
});

vi.mock("./workerLogger.js", () => ({
  wlog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  },
}));

/** Build a from() that resolves the api_call_logs select to a fixed result. */
function makeSelectRouter(result: { data: unknown[] | null; error: { message: string } | null }) {
  return () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = async () => result;
    return chain;
  };
}

describe("reconcileJobMargin", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetMarginMetricsForTest } = await import("./marginReconcile.js");
    __resetMarginMetricsForTest();
  });

  it("computes a positive margin and records the gauge", async () => {
    const { supabase } = await import("./supabase.js");
    // 50 credits × 0.03 = $1.50 charged; provider $0.40 → margin $1.10.
    vi.mocked(supabase.from).mockImplementation(
      makeSelectRouter({ data: [{ cost: 0.25 }, { cost: 0.15 }], error: null }) as never,
    );

    const { reconcileJobMargin, getMarginMetrics } = await import("./marginReconcile.js");
    const res = await reconcileJobMargin("job-1", 50);

    expect(res).not.toBeNull();
    expect(res!.chargedUsd).toBeCloseTo(1.5, 6);
    expect(res!.providerUsd).toBeCloseTo(0.4, 6);
    expect(res!.marginUsd).toBeCloseTo(1.1, 6);
    expect(res!.belowThreshold).toBe(false);

    const m = getMarginMetrics();
    expect(m.api_job_margin_usd).toBeCloseTo(1.1, 6);
    expect(m.api_jobs_reconciled_total).toBe(1);
    expect(m.api_jobs_negative_margin_total).toBe(0);
  });

  it("warns + counts a negative margin", async () => {
    const { supabase } = await import("./supabase.js");
    const { wlog } = await import("./workerLogger.js");
    // 10 credits × 0.03 = $0.30 charged; provider $2.68 → margin -$2.38.
    vi.mocked(supabase.from).mockImplementation(
      makeSelectRouter({ data: [{ cost: 2.68 }], error: null }) as never,
    );

    const { reconcileJobMargin, getMarginMetrics } = await import("./marginReconcile.js");
    const res = await reconcileJobMargin("job-neg", 10);

    expect(res!.marginUsd).toBeCloseTo(-2.38, 6);
    expect(res!.belowThreshold).toBe(true);
    expect(vi.mocked(wlog.warn)).toHaveBeenCalled();
    expect(getMarginMetrics().api_jobs_negative_margin_total).toBe(1);
  });

  it("no-ops on a zero/negative charge", async () => {
    const { reconcileJobMargin, getMarginMetrics } = await import("./marginReconcile.js");
    expect(await reconcileJobMargin("job-free", 0)).toBeNull();
    expect(await reconcileJobMargin("job-bad", -5)).toBeNull();
    expect(getMarginMetrics().api_jobs_reconciled_total).toBe(0);
    expect(getMarginMetrics().api_job_margin_usd).toBeNull();
  });

  it("swallows a DB read error and returns null", async () => {
    const { supabase } = await import("./supabase.js");
    vi.mocked(supabase.from).mockImplementation(
      makeSelectRouter({ data: null, error: { message: "connection reset" } }) as never,
    );
    const { reconcileJobMargin } = await import("./marginReconcile.js");
    await expect(reconcileJobMargin("job-err", 50)).resolves.toBeNull();
  });
});
