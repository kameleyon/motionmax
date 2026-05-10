/**
 * Worker lifecycle — graceful shutdown, signal handlers (SIGTERM /
 * SIGINT), and crash handlers (uncaughtException / unhandledRejection).
 * Extracted from worker/src/index.ts on 2026-05-10 (per audit C-4-3).
 *
 * Behavior preserved exactly:
 *  - SIGTERM/SIGINT/ADMIN_RESTART all funnel through gracefulShutdown
 *  - Active jobs are NEVER killed in-flight; the worker stops claiming
 *    new ones, drains the active pools for up to SHUTDOWN_DRAIN_TIMEOUT,
 *    then releases anything still running back to 'pending' so a
 *    sibling/successor can re-claim within seconds.
 *  - uncaughtException/unhandledRejection: Sentry-report, mark this
 *    worker's in-flight jobs failed, exit(1) so Render's supervisor
 *    cycles the pod.
 */
import * as Sentry from "@sentry/node";
import { supabase } from "./supabase.js";
import { writeSystemLog } from "./logger.js";
import { stopHealthServer } from "../healthServer.js";

/** Maximum time (ms) to wait for active jobs to drain during shutdown.
 *  Default: 60 s. Anything still running past this is released back to
 *  'pending' so the new worker can re-claim within seconds (vs. the
 *  10-min stale-claim threshold). Resumable handlers (e.g.
 *  handleCinematicVideo) read their saved checkpoint and skip
 *  external-API re-submits, so the in-flight work isn't lost. */
const SHUTDOWN_DRAIN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT || "60000", 10);

export interface LifecycleDeps {
  workerId: string;
  /** Total active jobs across both pools. */
  totalActiveJobs: () => number;
  /** All in-flight job ids (export + LLM pools). */
  allActiveJobIds: () => string[];
  /** Realtime channel created by subscribeToQueue() — null if none. */
  getRealtimeChannel: () => ReturnType<typeof supabase.channel> | null;
  clearRealtimeChannel: () => void;
  /** Fallback poll interval timer — cleared at the top of shutdown. */
  getFallbackPollTimer: () => ReturnType<typeof setInterval> | null;
  clearFallbackPollTimer: () => void;
  /** Setter for the entrypoint's shutting-down flag (so pollQueue
   *  returns early once shutdown begins). */
  setShuttingDown: (v: boolean) => void;
  isShuttingDown: () => boolean;
  /** Final totals reported in the shutdown log line. */
  getTotalsSnapshot: () => { totalJobsProcessed: number; totalJobsFailed: number };
}

export function makeGracefulShutdown(deps: LifecycleDeps) {
  /**
   * Initiate graceful shutdown.
   * 1. Stop accepting new jobs (isShuttingDown = true)
   * 2. Unsubscribe realtime channel and stop fallback poll
   * 3. Wait for all active jobs to finish (with timeout)
   * 4. Close health server
   * 5. Exit
   */
  return async function gracefulShutdown(signal: string): Promise<void> {
    if (deps.isShuttingDown()) {
      console.log(`[Worker] Already shutting down — ignoring duplicate ${signal}`);
      return;
    }

    deps.setShuttingDown(true);
    const activeCount = deps.totalActiveJobs();
    console.log(`[Worker] 🛑 Received ${signal} — initiating graceful shutdown`);
    console.log(`[Worker] Active jobs: ${activeCount} — will wait up to ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s for them to finish`);

    // Stop all job intake
    const ch = deps.getRealtimeChannel();
    if (ch) {
      await supabase.removeChannel(ch);
      deps.clearRealtimeChannel();
    }
    const timer = deps.getFallbackPollTimer();
    if (timer) {
      clearInterval(timer);
      deps.clearFallbackPollTimer();
    }

    await writeSystemLog({
      category: "system_info",
      eventType: "worker_shutdown_started",
      message: `Graceful shutdown initiated by ${signal} — ${activeCount} active job(s)`,
      details: { signal, activeJobCount: activeCount, activeJobIds: deps.allActiveJobIds() },
    });

    // Wait for active jobs to drain
    if (deps.totalActiveJobs() > 0) {
      const drainStart = Date.now();
      const DRAIN_CHECK_INTERVAL = 2000;

      await new Promise<void>((resolve) => {
        const checkDrained = () => {
          const elapsed = Date.now() - drainStart;

          if (deps.totalActiveJobs() === 0) {
            console.log(`[Worker] ✅ All active jobs drained in ${Math.round(elapsed / 1000)}s`);
            resolve();
            return;
          }

          if (elapsed >= SHUTDOWN_DRAIN_TIMEOUT_MS) {
            const stillActive = deps.allActiveJobIds();
            console.error(
              `[Worker] ⚠️  Shutdown drain timeout after ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s — ` +
              `${stillActive.length} job(s) still active: ${stillActive.join(", ")}. ` +
              `Releasing them back to 'pending' so a sibling/successor worker can re-claim.`,
            );
            // Release the still-running jobs to 'pending' so the new worker
            // instance picks them up within seconds via realtime, instead of
            // waiting for the 10-min stale-claim reaper. Resumable handlers
            // (handleCinematicVideo) consult their saved checkpoint and
            // skip the external-API re-submit, preserving Hypereal credits.
            // Race window: this old worker may finish a few more in-flight
            // ms of work after release; the checkpoint mechanism makes that
            // safe (last-write-wins on scene fields; no duplicate provider
            // submissions because the new worker resumes polling).
            (async () => {
              try {
                const { error: relErr } = await supabase
                  .from("video_generation_jobs")
                  .update({
                    status: "pending",
                    worker_id: null,
                    error_message: null,
                    updated_at: new Date().toISOString(),
                  })
                  .in("id", stillActive)
                  .eq("status", "processing");
                if (relErr) {
                  console.error(`[Worker] Failed to release jobs on drain timeout:`, relErr.message);
                } else {
                  console.log(`[Worker] ✅ Released ${stillActive.length} job(s) to 'pending' for fast hand-off`);
                }
              } catch (err) {
                console.error(`[Worker] Exception releasing jobs:`, (err as Error).message);
              }
            })();
            resolve();
            return;
          }

          console.log(
            `[Worker] Waiting for ${deps.totalActiveJobs()} active job(s) to finish... ` +
            `(${Math.round(elapsed / 1000)}s / ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s)`
          );
          setTimeout(checkDrained, DRAIN_CHECK_INTERVAL);
        };

        checkDrained();
      });
    }

    // Close health server
    await stopHealthServer();

    const totals = deps.getTotalsSnapshot();
    await writeSystemLog({
      category: "system_info",
      eventType: "worker_shutdown_complete",
      message: `Worker shutdown complete — processed ${totals.totalJobsProcessed} jobs, ${totals.totalJobsFailed} failed`,
      details: totals,
    });

    console.log(`[Worker] 👋 Shutdown complete. Total: ${totals.totalJobsProcessed} processed, ${totals.totalJobsFailed} failed.`);
    process.exit(0);
  };
}

/**
 * Register SIGTERM / SIGINT (graceful) and uncaughtException /
 * unhandledRejection (crash) handlers. Crash handlers mark this
 * worker's in-flight jobs failed (scoped to WORKER_ID so sibling
 * replicas aren't touched), then exit(1) so the orchestrator restarts.
 */
export function registerProcessSignalHandlers(
  workerId: string,
  gracefulShutdown: (signal: string) => Promise<void>,
): void {
  process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
  process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });

  // Intentional crash: capture to Sentry then exit so Render restarts the process.
  // Keeping the process alive after uncaught errors risks processing jobs in a corrupt state.
  process.on("uncaughtException", (err: Error) => {
    console.error("[Worker] 💥 Uncaught exception — marking jobs failed and exiting:", err.message);
    Sentry.captureException(err);
    // Mark this worker's in-flight jobs as failed so they are not orphaned.
    // Scope to WORKER_ID so sibling replicas' rows are not touched.
    // Fire-and-forget: do not await — we must exit promptly so the orchestrator can restart.
    supabase
      .from("video_generation_jobs")
      .update({ status: "failed", error_message: "Worker process crashed" })
      .eq("status", "processing")
      .eq("worker_id", workerId)
      .then(() => process.exit(1), () => process.exit(1));
  });
  process.on("unhandledRejection", (reason: unknown) => {
    console.error("[Worker] 💥 Unhandled rejection — marking jobs failed and exiting:", reason);
    const err = reason instanceof Error ? reason : new Error(String(reason));
    Sentry.captureException(err);
    // Mark this worker's in-flight jobs as failed so they are not orphaned.
    supabase
      .from("video_generation_jobs")
      .update({ status: "failed", error_message: "Worker process crashed" })
      .eq("status", "processing")
      .eq("worker_id", workerId)
      .then(() => process.exit(1), () => process.exit(1));
  });
}
