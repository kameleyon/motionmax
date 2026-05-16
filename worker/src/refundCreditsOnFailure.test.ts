/**
 * Tests for the REAL refundCreditsOnFailure helper (defined in src/index.ts).
 *
 * Probe F-10-02 (B-NEW-20) fix: this file used to mirror the function under
 * test inline ("Re-implement the idempotency contract in a testable helper
 * that mirrors the exact logic in src/index.ts"). That meant a developer
 * could break the real implementation without breaking these tests, and the
 * coverage was a fig leaf. The real function is now `export`ed from index.ts
 * (see worker/src/index.ts → refundCreditsOnFailure) and we import it here.
 *
 * The supabase client is intercepted via vi.mock so the real function runs
 * end-to-end against a controllable mock — no network, no real DB.
 *
 * Covers the idempotency fix identified in the Wave 2 audit:
 *   1. If a refund transaction already exists for the job_id → RPC must NOT be called.
 *   2. If no refund transaction exists → RPC MUST be called.
 *   3. If the idempotency check query itself errors → refund still proceeds (fail-safe).
 *   4. If the job has no user_id → skip entirely.
 *   5. If the task_type is not refundable (e.g. autopost_email_delivery) → skip.
 *   6. The refund description always contains the job id (cross-job isolation).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "./types/job.js";

// ── Supabase mock — intercepts before the real function imports it ────────────
//
// Built as a per-test fluent chain factory so individual tests can override
// `from(...).maybeSingle()` and `rpc(...)` results without setup boilerplate.

type MockQueryChain = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function makeMockChain(resolveWith: { data: unknown; error: unknown }): MockQueryChain {
  const chain: MockQueryChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(resolveWith),
  };
  // Make every method return the same chain object so it's fully fluent.
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}

vi.mock("./lib/supabase.js", () => {
  const supabase = {
    from: vi.fn(),
    rpc: vi.fn(),
  };
  return { supabase };
});

vi.mock("./lib/logger.js", () => ({
  writeSystemLog: vi.fn().mockResolvedValue(undefined),
}));

// Now import the REAL function under test (extracted to its own module so
// tests don't have to boot the full worker — health server, autopost
// dispatcher, newsletter loop, etc.).
import { refundCreditsOnFailure } from "./refundCreditsOnFailure.js";
// And the mocked supabase client so we can configure per-test responses.
import { supabase } from "./lib/supabase.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-refund-test",
    project_id: "proj-123",
    user_id: "user-abc",
    status: "failed",
    task_type: "generate_video",
    payload: { projectType: "doc2video", length: "brief" },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("refundCreditsOnFailure (real implementation) — idempotency contract", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── 1. Refund already exists → RPC must NOT be called ──────────────────────
  it("does NOT call RPC when an existing refund transaction is found", async () => {
    const existingTx = { id: "tx-existing-123" };
    const chain = makeMockChain({ data: existingTx, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob();
    await refundCreditsOnFailure(job);

    expect(supabase.from).toHaveBeenCalledWith("credit_transactions");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("skips the RPC regardless of credit amount when refund already exists", async () => {
    const chain = makeMockChain({ data: { id: "tx-cinematic-99" }, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      task_type: "generate_cinematic",
      payload: { projectType: "cinematic", length: "presentation" },
    });
    await refundCreditsOnFailure(job);

    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // ── 2. No existing refund → RPC MUST be called ─────────────────────────────
  it("calls RPC when no existing refund transaction is found", async () => {
    const chain = makeMockChain({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob();
    await refundCreditsOnFailure(job);

    expect(supabase.rpc).toHaveBeenCalledOnce();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "refund_credits_securely",
      expect.objectContaining({
        p_user_id: "user-abc",
        p_amount: expect.any(Number),
        p_description: expect.stringContaining(job.id),
      })
    );
  });

  it("refunds the correct credit amount for doc2video/brief", async () => {
    const chain = makeMockChain({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({ payload: { projectType: "doc2video", length: "brief" } });
    await refundCreditsOnFailure(job);

    // doc2video brief: ceil(280 * 1) = 280 credits
    expect(supabase.rpc).toHaveBeenCalledWith(
      "refund_credits_securely",
      expect.objectContaining({ p_amount: 280 })
    );
  });

  it("refunds the correct credit amount for smartflow/short", async () => {
    const chain = makeMockChain({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({ payload: { projectType: "smartflow", length: "short" } });
    await refundCreditsOnFailure(job);

    // smartflow short: ceil(150 * 0.5) = 75 credits
    expect(supabase.rpc).toHaveBeenCalledWith(
      "refund_credits_securely",
      expect.objectContaining({ p_amount: 75 })
    );
  });

  it("refunds the correct credit amount for cinematic/presentation", async () => {
    const chain = makeMockChain({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      task_type: "generate_cinematic",
      payload: { projectType: "cinematic", length: "presentation" },
    });
    await refundCreditsOnFailure(job);

    // cinematic presentation: ceil(280 * 5) = 1400 credits
    expect(supabase.rpc).toHaveBeenCalledWith(
      "refund_credits_securely",
      expect.objectContaining({ p_amount: 1400 })
    );
  });

  it("uses the exact creditsDeducted from payload when present (not the formula)", async () => {
    // Real implementation prefers payload.creditsDeducted over the formula
    // estimate. This shields legacy-pricing jobs from over-/under-refunding
    // when the formula changes.
    const chain = makeMockChain({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      payload: { projectType: "doc2video", length: "brief", creditsDeducted: 42 },
    });
    await refundCreditsOnFailure(job);

    expect(supabase.rpc).toHaveBeenCalledWith(
      "refund_credits_securely",
      expect.objectContaining({ p_amount: 42 })
    );
  });

  // ── 3. Idempotency check errors → refund still proceeds (fail-safe) ─────────
  it("still calls RPC when the idempotency check query itself returns an error", async () => {
    const chain = makeMockChain({
      data: null,
      error: { message: "connection reset by peer" },
    });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob();
    await refundCreditsOnFailure(job);

    expect(supabase.rpc).toHaveBeenCalledOnce();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "refund_credits_securely",
      expect.objectContaining({ p_user_id: "user-abc" })
    );
  });

  it("survives (does not throw) when both the idempotency check AND the RPC fail", async () => {
    const chain = makeMockChain({
      data: null,
      error: { message: "DB timeout" },
    });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: { message: "RPC failed" },
    } as never);

    const job = makeJob();
    await expect(refundCreditsOnFailure(job)).resolves.toBeUndefined();
  });

  // ── 4. No user_id → skipped entirely ───────────────────────────────────────
  it("skips the refund entirely when job has no user_id", async () => {
    vi.mocked(supabase.from).mockReturnValue(
      makeMockChain({ data: null, error: null }) as never
    );
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({ user_id: undefined as unknown as string });
    await refundCreditsOnFailure(job);

    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // ── 5. Non-refundable task type → skipped ──────────────────────────────────
  it("skips the refund when the task_type is downstream-only (e.g. autopost_email_delivery)", async () => {
    // The 2026-05-08 incident: autopost_email_delivery failed downstream
    // and the previous refund logic happily reimbursed the upstream
    // generation's credits. The fix gates refunds on a REFUNDABLE_TASK_TYPES
    // allowlist — verify it.
    vi.mocked(supabase.from).mockReturnValue(
      makeMockChain({ data: null, error: null }) as never
    );
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({ task_type: "autopost_email_delivery" });
    await refundCreditsOnFailure(job);

    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // ── 6a. Orphan-detected: autopost_render whose run already finished ──
  //
  // Probe C-10-4 PART D step 14 — extend orphan-detected paths.
  //
  // Scenario: a stale-claim reaper revives an autopost_render job (or
  // a duplicate row sneaks past idempotency) AFTER a sibling render has
  // already delivered the video. The autopost_runs row is in 'rendered'
  // / 'publishing' / 'completed' status. Refunding here double-credits
  // the user (they kept the rendered video AND get their credits back).
  // The refund handler must look at autopost_runs.status and SKIP.
  it("skips refund for autopost_render orphan when autopost_run is already 'rendered'", async () => {
    // 1st .from('autopost_runs') call returns the run row with status='rendered'.
    // refundCreditsOnFailure short-circuits before the credit_transactions
    // idempotency check, so we wire from() to return that row.
    const autopostRunChain = makeMockChain({
      data: { status: "rendered", video_job_id: "vid-job-sibling-1" },
      error: null,
    });
    vi.mocked(supabase.from).mockReturnValue(autopostRunChain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      // task_type "autopost_render" isn't in the typed union yet (the
      // production source reads it as string), so cast through unknown.
      task_type: "autopost_render" as unknown as Job["task_type"],
      payload: {
        projectType: "doc2video",
        length: "brief",
        creditsDeducted: 280,
        autopost_run_id: "run-sibling-1",
      },
    });
    await refundCreditsOnFailure(job);

    // No RPC call — the sibling already consumed the credits successfully.
    expect(supabase.rpc).not.toHaveBeenCalled();
    // We DID consult autopost_runs (to discover the orphan signal).
    expect(supabase.from).toHaveBeenCalledWith("autopost_runs");
  });

  it("skips refund for autopost_render orphan when autopost_run is 'publishing'", async () => {
    const chain = makeMockChain({
      data: { status: "publishing", video_job_id: "vid-job-pub-1" },
      error: null,
    });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      // task_type "autopost_render" isn't in the typed union yet (the
      // production source reads it as string), so cast through unknown.
      task_type: "autopost_render" as unknown as Job["task_type"],
      payload: {
        projectType: "doc2video",
        length: "brief",
        creditsDeducted: 280,
        autopost_run_id: "run-pub-1",
      },
    });
    await refundCreditsOnFailure(job);

    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("skips refund for autopost_render orphan when autopost_run is 'completed'", async () => {
    const chain = makeMockChain({
      data: { status: "completed", video_job_id: "vid-job-done-1" },
      error: null,
    });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      // task_type "autopost_render" isn't in the typed union yet (the
      // production source reads it as string), so cast through unknown.
      task_type: "autopost_render" as unknown as Job["task_type"],
      payload: {
        projectType: "doc2video",
        length: "brief",
        creditsDeducted: 280,
        autopost_run_id: "run-done-1",
      },
    });
    await refundCreditsOnFailure(job);

    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // ── 6b. autopost_render with creditsDeducted=0 → pre-deduction row, skip ──
  //
  // The orchestrator inserts a row BEFORE the credit deduction commits;
  // if that early row gets reaped as a stranded claim, refunding it
  // would credit the user for a deduction that never happened.
  it("skips refund for autopost_render rows whose payload has no creditsDeducted (pre-deduction)", async () => {
    vi.mocked(supabase.from).mockReturnValue(
      makeMockChain({ data: null, error: null }) as never,
    );
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      // task_type "autopost_render" isn't in the typed union yet (the
      // production source reads it as string), so cast through unknown.
      task_type: "autopost_render" as unknown as Job["task_type"],
      payload: { projectType: "doc2video", length: "brief" /* no creditsDeducted */ },
    });
    await refundCreditsOnFailure(job);

    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // ── 6c. autopost_render orphan with run status='pending' → refund proceeds ──
  //
  // The orphan-detection ONLY skips when a sibling has finished. If the
  // run is still pending / generating, the failure here genuinely means
  // the credits were lost; refund should proceed (subject to the
  // idempotency check on credit_transactions).
  it("DOES refund autopost_render orphan when autopost_run is still 'pending' (no sibling finish)", async () => {
    // Two from() calls happen in this path:
    //   1st: autopost_runs lookup (status='pending', no video_job_id)
    //   2nd: credit_transactions idempotency check (no existing refund)
    // Then supabase.rpc("refund_credits_securely") is called.
    const chainSequence = [
      makeMockChain({ data: { status: "pending", video_job_id: null }, error: null }),
      makeMockChain({ data: null, error: null }), // no existing refund tx
    ];
    let callIdx = 0;
    vi.mocked(supabase.from).mockImplementation(() => {
      const c = chainSequence[callIdx] ?? chainSequence[chainSequence.length - 1];
      callIdx += 1;
      return c as never;
    });
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      // task_type "autopost_render" isn't in the typed union yet (the
      // production source reads it as string), so cast through unknown.
      task_type: "autopost_render" as unknown as Job["task_type"],
      payload: {
        projectType: "doc2video",
        length: "brief",
        creditsDeducted: 280,
        autopost_run_id: "run-pending-1",
      },
    });
    await refundCreditsOnFailure(job);

    // The refund DID fire — exact amount from payload.creditsDeducted.
    expect(supabase.rpc).toHaveBeenCalledOnce();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "refund_credits_securely",
      expect.objectContaining({ p_amount: 280, p_user_id: "user-abc" }),
    );
  });

  // ── 6d. G-M10 (Ghost): autopost_rerender added to refundable set ──
  //
  // The audit flagged that `autopost_rerender` was missing from the
  // refundable task_types set, so a failed rerender carrying
  // creditsDeducted in its payload silently dropped the refund. The
  // fix adds it to the set AND extends the autopost_render-specific
  // guards (creditsDeducted-presence check + sibling-finished
  // check) to cover rerender identically.
  it("G-M10: skips refund for autopost_rerender rows whose payload has no creditsDeducted", async () => {
    vi.mocked(supabase.from).mockReturnValue(
      makeMockChain({ data: null, error: null }) as never,
    );
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      task_type: "autopost_rerender" as unknown as Job["task_type"],
      payload: { projectType: "doc2video", length: "brief" /* no creditsDeducted */ },
    });
    await refundCreditsOnFailure(job);

    // Pre-deduction row — no refund, no DB read.
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("G-M10: refunds autopost_rerender when run is 'pending' and creditsDeducted is set", async () => {
    const chainSequence = [
      makeMockChain({ data: { status: "pending", video_job_id: null }, error: null }),
      makeMockChain({ data: null, error: null }),
    ];
    let callIdx = 0;
    vi.mocked(supabase.from).mockImplementation(() => {
      const c = chainSequence[callIdx] ?? chainSequence[chainSequence.length - 1];
      callIdx += 1;
      return c as never;
    });
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      task_type: "autopost_rerender" as unknown as Job["task_type"],
      payload: {
        projectType: "doc2video",
        length: "brief",
        creditsDeducted: 140,
        autopost_run_id: "rerun-pending-1",
      },
    });
    await refundCreditsOnFailure(job);

    expect(supabase.rpc).toHaveBeenCalledOnce();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "refund_credits_securely",
      expect.objectContaining({ p_amount: 140, p_user_id: "user-abc" }),
    );
  });

  it("G-M10: skips refund for autopost_rerender when sibling run is already 'completed'", async () => {
    const chain = makeMockChain({
      data: { status: "completed", video_job_id: "vid-sibling-rerun" },
      error: null,
    });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const job = makeJob({
      task_type: "autopost_rerender" as unknown as Job["task_type"],
      payload: {
        projectType: "doc2video",
        length: "brief",
        creditsDeducted: 140,
        autopost_run_id: "rerun-done-1",
      },
    });
    await refundCreditsOnFailure(job);

    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // ── 7. Refund description includes job ID (prevents cross-job collisions) ───
  it("uses a description that uniquely identifies the job to prevent cross-job duplicates", async () => {
    const chain = makeMockChain({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);

    const jobA = makeJob({ id: "job-AAA" });
    const jobB = makeJob({ id: "job-BBB" });

    await refundCreditsOnFailure(jobA);
    await refundCreditsOnFailure(jobB);

    const rpcCalls = vi.mocked(supabase.rpc).mock.calls;
    const descA = (rpcCalls[0][1] as { p_description: string }).p_description;
    const descB = (rpcCalls[1][1] as { p_description: string }).p_description;

    expect(descA).toContain("job-AAA");
    expect(descB).toContain("job-BBB");
    expect(descA).not.toBe(descB);
  });
});
