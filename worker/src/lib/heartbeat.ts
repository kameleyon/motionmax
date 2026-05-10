/**
 * Worker heartbeat writer — every 15 s, UPSERT a row into
 * worker_heartbeats so the admin Performance tab can see this pod
 * (concurrency / in-flight / memory / CPU / version / uptime). Also
 * polls our row's restart_requested flag — if an admin clicked Restart
 * in TabPerformance, we trigger the supplied onRestartRequested
 * callback (typically the entrypoint's gracefulShutdown).
 *
 * Extracted from worker/src/index.ts on 2026-05-10 (per audit C-4-3).
 * Behavior preserved exactly: same interval, same fields, same
 * cgroup-aware memory + cpu math.
 */
import os from "os";
import { supabase } from "./supabase.js";
import { getContainerCpuCount, getContainerMemoryBytes } from "./concurrencyBudget.js";

export interface HeartbeatDeps {
  workerId: string;
  workerStartedAt: string;
  /** Returns total jobs in flight (export + LLM pools). */
  totalActiveJobs: () => number;
  /** Returns current total concurrency cap (export + LLM slots). */
  getMaxConcurrentJobs: () => number;
  /** Returns true once a graceful shutdown has been initiated so the
   *  heartbeat won't re-trigger the shutdown after the admin restart
   *  flag is already being honoured. */
  isShuttingDown: () => boolean;
  /** Invoked when worker_heartbeats.restart_requested flips to true. */
  onRestartRequested: () => void;
}

const HEARTBEAT_INTERVAL_MS = 15_000;

export function startHeartbeatWriter(deps: HeartbeatDeps): NodeJS.Timeout {
  const writeHeartbeat = async (): Promise<void> => {
    try {
      // Memory: prefer cgroup-aware container limit (set on Render),
      // fall back to process RSS / host total. cpu_pct uses 1-min
      // loadavg normalised by container CPU count — > 100 % is over-
      // saturated, so the UI's >80 % warn threshold catches it early.
      const memTotal = getContainerMemoryBytes();
      const memUsed  = process.memoryUsage().rss;
      const memoryPct = memTotal > 0 ? Math.min(100, (memUsed / memTotal) * 100) : 0;
      const cpuCount = getContainerCpuCount();
      const load1    = os.loadavg()[0];
      const cpuPct   = cpuCount > 0 ? Math.min(999, (load1 / cpuCount) * 100) : 0;

      const { data: row, error } = await supabase
        .from("worker_heartbeats")
        .upsert({
          worker_id: deps.workerId,
          host: os.hostname(),
          last_beat_at: new Date().toISOString(),
          in_flight: deps.totalActiveJobs(),
          concurrency: deps.getMaxConcurrentJobs(),
          memory_pct: Math.round(memoryPct * 10) / 10,
          cpu_pct: Math.round(cpuPct * 10) / 10,
          version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? process.env.npm_package_version ?? null,
          started_at: deps.workerStartedAt,
        }, { onConflict: "worker_id" })
        .select("restart_requested")
        .single();

      if (error) {
        console.warn(`[Heartbeat] write failed:`, error.message);
        return;
      }
      if ((row as { restart_requested?: boolean } | null)?.restart_requested && !deps.isShuttingDown()) {
        console.log(`[Worker] 🔄 restart_requested flag set by admin — initiating graceful shutdown`);
        // Clear the flag so the new pod doesn't immediately restart again.
        await supabase
          .from("worker_heartbeats")
          .update({ restart_requested: false })
          .eq("worker_id", deps.workerId);
        deps.onRestartRequested();
      }
    } catch (err) {
      console.warn(`[Heartbeat] exception:`, (err as Error).message);
    }
  };

  // Fire once on boot so the row appears immediately, then on interval.
  void writeHeartbeat();
  return setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
}
