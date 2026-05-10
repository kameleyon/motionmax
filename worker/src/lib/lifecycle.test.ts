/**
 * Tests for worker lifecycle / crash recovery — Probe C-10-4 PART D step 13.
 *
 * Contract enforced:
 *
 *  1. SIGTERM grace period drains in-flight jobs:
 *       gracefulShutdown waits until totalActiveJobs() === 0 OR the
 *       SHUTDOWN_DRAIN_TIMEOUT elapses. When it times out, the still-
 *       active jobs are released back to status='pending' so a sibling
 *       can re-claim within seconds (not waiting 30 min for the
 *       stale-claim reaper).
 *
 *  2. uncaughtException + checkpoint exists → release-not-fail (C-7-8):
 *       The crash handler MUST NOT terminally mark a checkpointed job
 *       as failed — it would re-submit to Hypereal on retry and double-
 *       spend credits. Instead the row goes to status='pending' and
 *       worker_id=null so the resume path runs.
 *
 *  3. uncaughtException + no checkpoint → terminal-fail (C-7-8):
 *       Without a resume signal, "release" would mean starting from
 *       scratch on another worker which itself re-submits to providers.
 *       Better to fail and let refundCreditsOnFailure refund the user.
 *
 * Implementation note: `registerProcessSignalHandlers` mutates global
 * `process.on(...)` listeners, so we exercise it via the wired callbacks
 * captured at registration time rather than firing real OS signals.
 * The triage helper (`crashTriageInFlightJobs`) is internal so we drive
 * it through `registerProcessSignalHandlers` → "uncaughtException"
 * listener → process.exit interception.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("./supabase.js", () => {
  const supabase = {
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn().mockResolvedValue(undefined),
  };
  return { supabase };
});

vi.mock("./logger.js", () => ({
  writeSystemLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../healthServer.js", () => ({
  stopHealthServer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

// Default: no checkpoint exists. Overridden per-test to flip release/fail.
const hasCheckpointMock = vi.fn().mockResolvedValue(false);
vi.mock("./checkpoint.js", () => ({
  hasCheckpoint: hasCheckpointMock,
}));

// ── Fluent supabase update-chain builder ────────────────────────────
//
// crashTriageInFlightJobs does:
//   supabase.from('video_generation_jobs')
//     .select('id, task_type').eq('status', 'processing').eq('worker_id', ...)
// then per row:
//   supabase.from('video_generation_jobs')
//     .update({...}).eq('id', ...).eq('worker_id', ...).eq('status', 'processing')

interface UpdateRecord {
  updateData: Record<string, unknown>;
  eqCalls: Array<[string, unknown]>;
}

function makeSelectChain(rows: Array<{ id: string; task_type: string }>) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  // The terminal of the select chain is the await of `.eq(...).eq(...)`
  // which the supabase-js client makes thenable. We attach .then for
  // that.
  (chain as { then: (cb: (v: unknown) => unknown) => unknown }).then = (
    cb: (v: unknown) => unknown,
  ) => Promise.resolve({ data: rows, error: null }).then(cb);
  return chain;
}

function makeUpdateChain(record: UpdateRecord) {
  const chain: Record<string, unknown> = {};
  chain.update = vi.fn().mockImplementation((data: Record<string, unknown>) => {
    record.updateData = data;
    return chain;
  });
  chain.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
    record.eqCalls.push([col, val]);
    return chain;
  });
  chain.in = vi.fn().mockReturnValue(chain);
  // Thenable terminus — used by `await supabase.from(...).update(...).eq(...)`.
  (chain as { then: (cb: (v: unknown) => unknown) => unknown }).then = (
    cb: (v: unknown) => unknown,
  ) => Promise.resolve({ data: null, error: null }).then(cb);
  return chain;
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeLifecycleDeps(overrides: Record<string, unknown> = {}) {
  let shuttingDown = false;
  return {
    workerId: "worker-test-1",
    totalActiveJobs: vi.fn().mockReturnValue(0),
    allActiveJobIds: vi.fn().mockReturnValue([]),
    getRealtimeChannel: vi.fn().mockReturnValue(null),
    clearRealtimeChannel: vi.fn(),
    getFallbackPollTimer: vi.fn().mockReturnValue(null),
    clearFallbackPollTimer: vi.fn(),
    setShuttingDown: vi.fn().mockImplementation((v: boolean) => {
      shuttingDown = v;
    }),
    isShuttingDown: vi.fn().mockImplementation(() => shuttingDown),
    getTotalsSnapshot: vi.fn().mockReturnValue({ totalJobsProcessed: 0, totalJobsFailed: 0 }),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("makeGracefulShutdown — SIGTERM drain", () => {
  let originalExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    exitCode = undefined;
    originalExit = process.exit;
    // Replace exit with a no-throw spy so the test continues.
    process.exit = vi.fn().mockImplementation((code?: number) => {
      exitCode = code;
      // Don't actually exit — return undefined cast to never to satisfy the typing.
      return undefined as never;
    }) as never;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("drains promptly when totalActiveJobs is already zero", async () => {
    const deps = makeLifecycleDeps({
      totalActiveJobs: vi.fn().mockReturnValue(0),
    });

    const { makeGracefulShutdown } = await import("./lifecycle.js");
    const shutdown = makeGracefulShutdown(deps as never);
    await shutdown("SIGTERM");

    // Healthy quick exit: setShuttingDown(true), then exit(0).
    expect(deps.setShuttingDown).toHaveBeenCalledWith(true);
    expect(exitCode).toBe(0);
  });

  it("ignores duplicate signals (re-entrant guard)", async () => {
    let isDown = true; // already shutting down
    const deps = makeLifecycleDeps({
      isShuttingDown: vi.fn().mockImplementation(() => isDown),
      setShuttingDown: vi.fn().mockImplementation((v: boolean) => {
        isDown = v;
      }),
    });

    const { makeGracefulShutdown } = await import("./lifecycle.js");
    const shutdown = makeGracefulShutdown(deps as never);
    await shutdown("SIGTERM");

    // Re-entrant SIGTERM: setShuttingDown should NOT be called a second
    // time, and process.exit should not fire.
    expect(deps.setShuttingDown).not.toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
  });

  it("releases still-active jobs back to 'pending' on drain timeout", async () => {
    // Configure: 2 active jobs that never finish + a very short timeout.
    // Set the env BEFORE resetModules so the freshly-imported module
    // sees the override at its constant init.
    process.env.SHUTDOWN_DRAIN_TIMEOUT = "200"; // 200 ms

    const stillActive = ["job-stuck-1", "job-stuck-2"];
    const updateRecord: UpdateRecord = { updateData: {}, eqCalls: [] };

    // Re-import fresh so SHUTDOWN_DRAIN_TIMEOUT_MS picks up the new env.
    // Re-fetch supabase from the new module graph and wire the mock
    // implementation against THAT instance.
    vi.resetModules();
    const { supabase } = await import("./supabase.js");
    vi.mocked(supabase.from).mockImplementation(() =>
      makeUpdateChain(updateRecord) as never,
    );

    const deps = makeLifecycleDeps({
      totalActiveJobs: vi.fn().mockReturnValue(2), // always 2 active
      allActiveJobIds: vi.fn().mockReturnValue(stillActive),
    });

    const { makeGracefulShutdown } = await import("./lifecycle.js");

    const shutdown = makeGracefulShutdown(deps as never);
    await shutdown("SIGTERM");

    // The release is dispatched via a fire-and-forget IIFE inside the
    // drain-timeout branch; give microtasks a tick to drain.
    await new Promise((r) => setTimeout(r, 20));

    // The release happens via supabase.from('video_generation_jobs').update(...).in('id', stillActive).eq('status', 'processing')
    expect(updateRecord.updateData.status).toBe("pending");
    expect(updateRecord.updateData.worker_id).toBe(null);
    // Exit still happens (code 0 — graceful, not crash).
    expect(exitCode).toBe(0);

    delete process.env.SHUTDOWN_DRAIN_TIMEOUT;
  });
});

describe("registerProcessSignalHandlers — uncaughtException triage (C-7-8)", () => {
  let originalExit: typeof process.exit;
  let exitCode: number | undefined;
  // Capture handlers wired by registerProcessSignalHandlers so we can
  // invoke them directly without firing real OS signals.
  const wiredHandlers = new Map<string, (...args: unknown[]) => unknown>();
  let originalProcessOn: typeof process.on;

  beforeEach(() => {
    vi.clearAllMocks();
    hasCheckpointMock.mockReset().mockResolvedValue(false);
    wiredHandlers.clear();
    exitCode = undefined;
    originalExit = process.exit;
    originalProcessOn = process.on;

    process.exit = vi.fn().mockImplementation((code?: number) => {
      exitCode = code;
      return undefined as never;
    }) as never;

    // Intercept process.on calls so we can fire handlers manually.
    (process as { on: typeof process.on }).on = vi.fn().mockImplementation(
      (event: string, handler: (...args: unknown[]) => unknown) => {
        wiredHandlers.set(event, handler);
        return process;
      },
    ) as typeof process.on;
  });

  afterEach(() => {
    process.exit = originalExit;
    (process as { on: typeof process.on }).on = originalProcessOn;
  });

  it("releases an in-flight job to 'pending' when a checkpoint exists", async () => {
    // Checkpoint says: this job is resumable.
    hasCheckpointMock.mockResolvedValue(true);

    // Set up supabase mock:
    //   1st from() — select in-flight rows (1 row returned)
    //   2nd from() — update that row to 'pending'
    const updateRecord: UpdateRecord = { updateData: {}, eqCalls: [] };
    const { supabase } = await import("./supabase.js");
    let callIdx = 0;
    vi.mocked(supabase.from).mockImplementation(() => {
      const idx = callIdx++;
      if (idx === 0) {
        return makeSelectChain([
          { id: "job-resume-1", task_type: "cinematic_video" },
        ]) as never;
      }
      return makeUpdateChain(updateRecord) as never;
    });

    const { registerProcessSignalHandlers, makeGracefulShutdown } = await import("./lifecycle.js");
    const deps = makeLifecycleDeps();
    const shutdown = makeGracefulShutdown(deps as never);
    registerProcessSignalHandlers("worker-test-1", shutdown);

    const uncaughtHandler = wiredHandlers.get("uncaughtException");
    expect(uncaughtHandler).toBeDefined();

    // Trigger the crash handler.
    uncaughtHandler!(new Error("boom"));

    // Give microtasks a moment to drain the triage + process.exit.
    await new Promise((r) => setTimeout(r, 50));

    // The triage chose RELEASE (status='pending', worker_id=null).
    expect(updateRecord.updateData.status).toBe("pending");
    expect(updateRecord.updateData.worker_id).toBe(null);
    expect(updateRecord.updateData.error_message).toBe(null);
    // The worker still exits with code 1 (crash) so Render restarts the pod.
    // The triage budget caps at 5s but the test mock is instant; either
    // way the exit happens.
    await new Promise((r) => setTimeout(r, 100));
    expect(exitCode).toBe(1);
  });

  it("marks an in-flight job 'failed' when no checkpoint exists", async () => {
    // No checkpoint: failing is safer than re-submitting.
    hasCheckpointMock.mockResolvedValue(false);

    const updateRecord: UpdateRecord = { updateData: {}, eqCalls: [] };
    const { supabase } = await import("./supabase.js");
    let callIdx = 0;
    vi.mocked(supabase.from).mockImplementation(() => {
      const idx = callIdx++;
      if (idx === 0) {
        return makeSelectChain([
          { id: "job-fail-1", task_type: "generate_video" },
        ]) as never;
      }
      return makeUpdateChain(updateRecord) as never;
    });

    const { registerProcessSignalHandlers, makeGracefulShutdown } = await import("./lifecycle.js");
    const deps = makeLifecycleDeps();
    const shutdown = makeGracefulShutdown(deps as never);
    registerProcessSignalHandlers("worker-test-1", shutdown);

    const uncaughtHandler = wiredHandlers.get("uncaughtException");
    uncaughtHandler!(new Error("kaboom"));

    await new Promise((r) => setTimeout(r, 50));

    // The triage chose FAIL (status='failed', error_message set).
    expect(updateRecord.updateData.status).toBe("failed");
    expect(typeof updateRecord.updateData.error_message).toBe("string");
    expect((updateRecord.updateData.error_message as string).toLowerCase()).toContain("crashed");

    await new Promise((r) => setTimeout(r, 100));
    expect(exitCode).toBe(1);
  });

  it("handles unhandledRejection symmetrically (same triage path)", async () => {
    hasCheckpointMock.mockResolvedValue(true);

    const updateRecord: UpdateRecord = { updateData: {}, eqCalls: [] };
    const { supabase } = await import("./supabase.js");
    let callIdx = 0;
    vi.mocked(supabase.from).mockImplementation(() => {
      const idx = callIdx++;
      if (idx === 0) {
        return makeSelectChain([
          { id: "job-rej-1", task_type: "cinematic_video" },
        ]) as never;
      }
      return makeUpdateChain(updateRecord) as never;
    });

    const { registerProcessSignalHandlers, makeGracefulShutdown } = await import("./lifecycle.js");
    const deps = makeLifecycleDeps();
    const shutdown = makeGracefulShutdown(deps as never);
    registerProcessSignalHandlers("worker-test-1", shutdown);

    const rejectionHandler = wiredHandlers.get("unhandledRejection");
    expect(rejectionHandler).toBeDefined();

    rejectionHandler!(new Error("rejected"));

    await new Promise((r) => setTimeout(r, 50));

    // Checkpoint exists → release.
    expect(updateRecord.updateData.status).toBe("pending");

    await new Promise((r) => setTimeout(r, 100));
    expect(exitCode).toBe(1);
  });
});
