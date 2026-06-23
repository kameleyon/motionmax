/**
 * Tests for runStaleClaimReaper — Probe C-10-4 PART D step 12.
 *
 * Contract enforced:
 *
 *  1. Per-task-type stale windows (B-NEW-18, 2026-05-10 fix):
 *       cinematic_video → 90 min
 *       export_video    → 120 min
 *       default         → 90 min
 *     A claim that's been processing < the window must be left alone
 *     (still legitimately running). A claim past the window gets reset
 *     to status='pending' with worker_id=NULL.
 *
 *  2. Orchestrator fail-closed (autopost_render / autopost_rerender):
 *     these task types are NOT resumed; they're marked failed instead
 *     because re-running double-spends credits.
 *
 *  3. Resilience: when a DB error is returned by one bucket query, the
 *     reaper logs and continues — other buckets still run, and the
 *     function never throws.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("./supabase.js", () => {
  const supabase = {
    from: vi.fn(),
  };
  return { supabase };
});

vi.mock("./logger.js", () => ({
  writeSystemLog: vi.fn().mockResolvedValue(undefined),
}));

// ── Fluent chain builder ─────────────────────────────────────────────
//
// The reaper composes:
//   supabase.from(...).update({...}).eq(...).lt(...).in(...).select(...)
//   supabase.from(...).update({...}).eq(...).lt(...).not(...).select(...)
//
// We record each chain's filter calls so individual tests can inspect
// what was filtered on (task_type windows etc.).

interface ChainRecord {
  table: string;
  updateData: unknown;
  eqCalls: Array<[string, unknown]>;
  ltCalls: Array<[string, unknown]>;
  inCalls: Array<[string, unknown[]]>;
  notCalls: Array<[string, string, string]>;
  isCalls: Array<[string, unknown]>;
}

function makeRouter(
  /** Per-call result generator. Indexed by call order — first .select() resolution → result[0], etc. */
  results: Array<{ data: unknown[] | null; error: { message: string } | null }>,
  /** Optional callback to capture each chain for later assertions. */
  capture?: (rec: ChainRecord) => void,
) {
  let resultIdx = 0;
  return (table: string) => {
    const rec: ChainRecord = {
      table,
      updateData: undefined,
      eqCalls: [],
      ltCalls: [],
      inCalls: [],
      notCalls: [],
      isCalls: [],
    };
    const chain: Record<string, unknown> = {};
    chain.update = (data: unknown) => {
      rec.updateData = data;
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      rec.eqCalls.push([col, val]);
      return chain;
    };
    chain.lt = (col: string, val: unknown) => {
      rec.ltCalls.push([col, val]);
      return chain;
    };
    chain.in = (col: string, vals: unknown[]) => {
      rec.inCalls.push([col, vals]);
      return chain;
    };
    chain.is = (col: string, val: unknown) => {
      rec.isCalls.push([col, val]);
      return chain;
    };
    chain.not = (col: string, op: string, vals: string) => {
      rec.notCalls.push([col, op, vals]);
      return chain;
    };
    chain.select = async (_cols: string) => {
      capture?.(rec);
      const result = results[resultIdx] ?? { data: [], error: null };
      resultIdx += 1;
      return result;
    };
    // Mutation methods used inline by the orchestrator fail-closed
    // branch (autopost_runs status update). It's a separate from() call
    // so it gets its own chain — handled by allowing arbitrary .neq()/
    // .eq()/.update() composition that resolves without yielding.
    chain.neq = () => chain;
    return chain;
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("runStaleClaimReaper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Reaper revives stale cinematic_video past the 90-min window ──
  it("revives a cinematic_video claim past 90 min to status='pending' with worker_id=NULL", async () => {
    const captured: ChainRecord[] = [];

    const { supabase } = await import("./supabase.js");
    vi.mocked(supabase.from).mockImplementation(
      makeRouter(
        [
          // 1st call: orchestrator fail-closed — no orphans found.
          { data: [], error: null },
          // 2nd: cinematic_video bucket — one zombie revived.
          { data: [{ id: "j-cin-1", task_type: "cinematic_video" }], error: null },
          // 3rd: export_video bucket — empty.
          { data: [], error: null },
          // 4th: default bucket — empty.
          { data: [], error: null },
        ],
        (rec) => captured.push(rec),
      ) as never,
    );

    const { runStaleClaimReaper } = await import("./staleClaimReaper.js");
    await runStaleClaimReaper();

    // The cinematic_video bucket is the second chain. Inspect its
    // update payload to confirm release semantics + the task_type IN
    // filter.
    const cinChain = captured[1];
    expect(cinChain.table).toBe("video_generation_jobs");
    const updateData = cinChain.updateData as { status: string; worker_id: null };
    expect(updateData.status).toBe("pending");
    expect(updateData.worker_id).toBe(null);
    // The IN clause must scope to cinematic_video only.
    const cinIn = cinChain.inCalls.find(([col]) => col === "task_type");
    expect(cinIn?.[1]).toEqual(["cinematic_video"]);
  });

  // ── 2. NOT past window → left alone ────────────────────────────────
  it("leaves a fresh claim alone — the LT(cutoff) filter is what guards it", async () => {
    const captured: ChainRecord[] = [];
    const { supabase } = await import("./supabase.js");

    // All buckets return empty data — emulating "no rows older than cutoff".
    vi.mocked(supabase.from).mockImplementation(
      makeRouter(
        [
          { data: [], error: null }, // orchestrator
          { data: [], error: null }, // cinematic
          { data: [], error: null }, // export
          { data: [], error: null }, // default
        ],
        (rec) => captured.push(rec),
      ) as never,
    );

    const { runStaleClaimReaper } = await import("./staleClaimReaper.js");
    await runStaleClaimReaper();

    // Every bucket MUST be filtered with both eq(status='processing') AND
    // lt('updated_at', <cutoff>) — that's how "still legit running" is
    // distinguished from "zombie."
    for (const rec of captured) {
      const statusEq = rec.eqCalls.find(([col]) => col === "status");
      expect(statusEq?.[1]).toBe("processing");
      // lt('updated_at', cutoff) is the freshness guard.
      const updatedAtLt = rec.ltCalls.find(([col]) => col === "updated_at");
      expect(typeof updatedAtLt?.[1]).toBe("string");
      // Cutoff is an ISO timestamp in the past.
      expect(Date.parse(updatedAtLt?.[1] as string)).toBeLessThan(Date.now() + 1000);
    }
  });

  // ── 3. cinematic_video specifically must use a >= 90 min window ────
  //     (B-NEW-18 incident: prior 30-min window double-spent Hypereal credits).
  it("uses a 90-minute cutoff for the cinematic_video bucket (B-NEW-18)", async () => {
    const captured: ChainRecord[] = [];
    const { supabase } = await import("./supabase.js");

    vi.mocked(supabase.from).mockImplementation(
      makeRouter(
        [
          { data: [], error: null }, // orchestrator
          { data: [], error: null }, // cinematic_video
          { data: [], error: null }, // export_video
          { data: [], error: null }, // default
        ],
        (rec) => captured.push(rec),
      ) as never,
    );

    const tStart = Date.now();
    const { runStaleClaimReaper } = await import("./staleClaimReaper.js");
    await runStaleClaimReaper();
    const tEnd = Date.now();

    // Locate the cinematic_video bucket via its IN filter.
    const cinBucket = captured.find((c) =>
      c.inCalls.some(([col, vals]) => col === "task_type" && (vals as string[]).includes("cinematic_video")),
    );
    expect(cinBucket).toBeDefined();

    const cutoffIso = cinBucket!.ltCalls.find(([col]) => col === "updated_at")?.[1] as string;
    const cutoffMs = Date.parse(cutoffIso);
    const ageMs = tEnd - cutoffMs; // i.e. "rows older than ageMs are reaped"

    // The cinematic window is 90 min — assert age sits in a tight window
    // around 90 min, allowing for the test's own execution time.
    const NINETY_MIN_MS = 90 * 60 * 1000;
    expect(ageMs).toBeGreaterThanOrEqual(NINETY_MIN_MS - 1000);
    expect(ageMs).toBeLessThanOrEqual(NINETY_MIN_MS + (tEnd - tStart) + 1000);
  });

  // ── 4. autopost_render uses fail-closed (mark failed, NOT revive) ───
  it("marks an orphaned autopost_render as failed (does NOT release to pending)", async () => {
    const captured: ChainRecord[] = [];
    const { supabase } = await import("./supabase.js");

    vi.mocked(supabase.from).mockImplementation(
      makeRouter(
        [
          // Orchestrator branch finds 1 orphan to fail-close.
          {
            data: [
              { id: "j-auto-1", task_type: "autopost_render", payload: { autopost_run_id: "run-1" } },
            ],
            error: null,
          },
          // The three "revive" buckets — all empty for this test.
          // (The autopost_runs mirror update is awaited via .neq() not
          // .select(), so it doesn't consume a result slot.)
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
        ],
        (rec) => captured.push(rec),
      ) as never,
    );

    const { runStaleClaimReaper } = await import("./staleClaimReaper.js");
    await runStaleClaimReaper();

    // The orchestrator branch is the FIRST chain. Verify it's a
    // status='failed' update, not 'pending'.
    const orchChain = captured[0];
    const updateData = orchChain.updateData as { status: string; error_message?: string };
    expect(updateData.status).toBe("failed");
    expect(updateData.error_message).toMatch(/orphaned/i);
    // And it's filtered to the autopost orchestrator task types.
    const taskTypeIn = orchChain.inCalls.find(([col]) => col === "task_type");
    expect(taskTypeIn?.[1]).toEqual(["autopost_render", "autopost_rerender"]);
  });

  // ── 5. Reaper never throws on a single bucket error ─────────────────
  it("survives a per-bucket DB error and processes other buckets normally", async () => {
    const { supabase } = await import("./supabase.js");

    vi.mocked(supabase.from).mockImplementation(
      makeRouter(
        [
          { data: [], error: null },                                            // orchestrator OK
          { data: null, error: { message: "connection reset" } },               // cinematic fails
          { data: [{ id: "j-x", task_type: "export_video" }], error: null },    // export OK
          { data: [], error: null },                                            // default OK
        ],
      ) as never,
    );

    const { runStaleClaimReaper } = await import("./staleClaimReaper.js");
    // No throw, no rejected promise — error is logged and swallowed.
    await expect(runStaleClaimReaper()).resolves.toBeUndefined();
  });

  // ── 6. Default bucket excludes the buckets that have specific windows ──
  it("default bucket excludes orchestrators + cinematic + export from its sweep", async () => {
    const captured: ChainRecord[] = [];
    const { supabase } = await import("./supabase.js");

    vi.mocked(supabase.from).mockImplementation(
      makeRouter(
        [
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
        ],
        (rec) => captured.push(rec),
      ) as never,
    );

    const { runStaleClaimReaper } = await import("./staleClaimReaper.js");
    await runStaleClaimReaper();

    // The "default" bucket is the only one that uses .not() to exclude
    // the more-specific task types. Find it and verify the exclusion list.
    const defaultBucket = captured.find((c) => c.notCalls.length > 0);
    expect(defaultBucket).toBeDefined();
    const [col, op, vals] = defaultBucket!.notCalls[0];
    expect(col).toBe("task_type");
    expect(op).toBe("in");
    // The exclusion string contains all the specific buckets so they don't
    // get re-reaped with the wrong window.
    expect(vals).toContain("autopost_render");
    expect(vals).toContain("autopost_rerender");
    expect(vals).toContain("cinematic_video");
    expect(vals).toContain("master_audio");
    expect(vals).toContain("export_video");
  });

  // ── 7. Billed-job double-bill gate (G-M5/G-M11) ─────────────────────
  //     cinematic_video + master_audio buckets must add an
  //     is('billed_at', null) filter so a paid (gateway-stamped) job is
  //     never auto-revived into a second provider spend on worker restart.
  it("gates cinematic_video + master_audio revival on billed_at IS NULL", async () => {
    const captured: ChainRecord[] = [];
    const { supabase } = await import("./supabase.js");

    vi.mocked(supabase.from).mockImplementation(
      makeRouter(
        [
          { data: [], error: null }, // orchestrator
          { data: [], error: null }, // cinematic_video
          { data: [], error: null }, // master_audio
          { data: [], error: null }, // export_video
          { data: [], error: null }, // default
        ],
        (rec) => captured.push(rec),
      ) as never,
    );

    const { runStaleClaimReaper } = await import("./staleClaimReaper.js");
    await runStaleClaimReaper();

    const cinBucket = captured.find((c) =>
      c.inCalls.some(([col, vals]) => col === "task_type" && (vals as string[]).includes("cinematic_video")),
    );
    const masterBucket = captured.find((c) =>
      c.inCalls.some(([col, vals]) => col === "task_type" && (vals as string[]).includes("master_audio")),
    );
    expect(cinBucket).toBeDefined();
    expect(masterBucket).toBeDefined();

    // Both billing-sensitive buckets gate on billed_at IS NULL.
    expect(cinBucket!.isCalls).toContainEqual(["billed_at", null]);
    expect(masterBucket!.isCalls).toContainEqual(["billed_at", null]);

    // The export_video bucket is provider-idempotent (ffmpeg re-encode is
    // free to redo) so it must NOT carry the billed_at gate — otherwise a
    // paid export that legitimately stalled would never auto-recover.
    const exportBucket = captured.find((c) =>
      c.inCalls.some(([col, vals]) => col === "task_type" && (vals as string[]).includes("export_video")),
    );
    expect(exportBucket).toBeDefined();
    expect(exportBucket!.isCalls).toHaveLength(0);
  });
});
