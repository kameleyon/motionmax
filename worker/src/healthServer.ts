/**
 * Production HTTP health-check server for Render (or any orchestrator).
 *
 * Exposes:
 *   GET /health   → 200 + JSON body with worker vitals
 *   GET /ready    → 200 if worker is accepting jobs, 503 if shutting down
 *   GET /metrics  → 200 + JSON body with detailed operational metrics
 *
 * Uses Node.js built-in `http` — zero external dependencies.
 * Bind port via HEALTH_PORT env (default 10000 — Render's expected port).
 */
import http from "http";
import { supabase } from "./lib/supabase.js";

// ── Types ────────────────────────────────────────────────────────────

export interface WorkerVitals {
  /** Number of jobs currently being processed */
  activeJobs: number;
  /** Maximum concurrent jobs allowed */
  maxConcurrentJobs: number;
  /** Whether the worker is accepting new jobs */
  accepting: boolean;
  /** Worker uptime in seconds */
  uptimeSeconds: number;
  /** Timestamp of last successful poll cycle */
  lastPollAt: string | null;
  /** Current Supabase Realtime channel status */
  realtimeStatus: string;
  /** How stale lastPollAt can be before /ready fails (ms) */
  pollStaleThresholdMs: number;
  /** Total jobs processed since startup */
  totalJobsProcessed: number;
  /** Total jobs that failed since startup */
  totalJobsFailed: number;
}

type VitalsProvider = () => WorkerVitals;

// ── Server ───────────────────────────────────────────────────────────

let server: http.Server | null = null;
let vitalsProvider: VitalsProvider | null = null;
const startedAt = Date.now();

function buildHealthResponse(vitals: WorkerVitals) {
  const mem = process.memoryUsage();
  return {
    status: "ok",
    service: "motionmax-worker",
    version: process.env.npm_package_version || "1.0.0",
    uptime: vitals.uptimeSeconds,
    timestamp: new Date().toISOString(),
    worker: {
      activeJobs: vitals.activeJobs,
      maxConcurrentJobs: vitals.maxConcurrentJobs,
      accepting: vitals.accepting,
      availableSlots: vitals.maxConcurrentJobs - vitals.activeJobs,
      lastPollAt: vitals.lastPollAt,
    },
    memory: {
      rssBytes: mem.rss,
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedBytes: mem.heapUsed,
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalBytes: mem.heapTotal,
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      externalBytes: mem.external,
    },
    system: {
      platform: process.platform,
      nodeVersion: process.version,
      pid: process.pid,
    },
  };
}

function buildMetricsJson(vitals: WorkerVitals) {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    timestamp: new Date().toISOString(),
    uptimeSeconds: vitals.uptimeSeconds,
    jobs: {
      active: vitals.activeJobs,
      maxConcurrent: vitals.maxConcurrentJobs,
      availableSlots: vitals.maxConcurrentJobs - vitals.activeJobs,
      totalProcessed: vitals.totalJobsProcessed,
      totalFailed: vitals.totalJobsFailed,
      accepting: vitals.accepting,
      lastPollAt: vitals.lastPollAt,
    },
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers,
    },
    cpu: {
      userMicroseconds: cpu.user,
      systemMicroseconds: cpu.system,
    },
  };
}

/** Prometheus text exposition format (text/plain; version=0.0.4). */
function buildMetricsPrometheus(vitals: WorkerVitals): string {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const lines: string[] = [];

  const gauge = (name: string, help: string, value: number) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  };
  const counter = (name: string, help: string, value: number) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  };

  gauge("motionmax_worker_uptime_seconds", "Worker uptime in seconds", vitals.uptimeSeconds);
  gauge("motionmax_worker_jobs_active", "Jobs currently being processed", vitals.activeJobs);
  gauge("motionmax_worker_jobs_max_concurrent", "Maximum concurrent jobs", vitals.maxConcurrentJobs);
  gauge("motionmax_worker_jobs_available_slots", "Available job slots", vitals.maxConcurrentJobs - vitals.activeJobs);
  gauge("motionmax_worker_accepting", "Whether the worker is accepting jobs (1=yes, 0=no)", vitals.accepting ? 1 : 0);
  counter("motionmax_worker_jobs_processed_total", "Total jobs processed since startup", vitals.totalJobsProcessed);
  counter("motionmax_worker_jobs_failed_total", "Total jobs failed since startup", vitals.totalJobsFailed);
  gauge("motionmax_worker_memory_rss_bytes", "Resident set size in bytes", mem.rss);
  gauge("motionmax_worker_memory_heap_used_bytes", "V8 heap used in bytes", mem.heapUsed);
  gauge("motionmax_worker_memory_heap_total_bytes", "V8 heap total in bytes", mem.heapTotal);
  counter("motionmax_worker_cpu_user_microseconds_total", "CPU user time in microseconds", cpu.user);
  counter("motionmax_worker_cpu_system_microseconds_total", "CPU system time in microseconds", cpu.system);

  return lines.join("\n") + "\n";
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // CORS headers for monitoring dashboards
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  const url = req.url?.split("?")[0] || "/";

  // Bearer token auth for /metrics
  const authToken = process.env.HEALTH_AUTH_TOKEN;
  if (url === "/metrics") {
    if (!authToken && process.env.NODE_ENV === "production") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Metrics endpoint requires HEALTH_AUTH_TOKEN in production" }));
      return;
    }
    if (authToken) {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${authToken}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }
  }

  if (!vitalsProvider) {
    res.writeHead(503);
    res.end(JSON.stringify({ status: "unavailable", message: "Worker not initialized" }));
    return;
  }

  const vitals = vitalsProvider();

  switch (url) {
    case "/health":
    case "/healthz":
    case "/": {
      try {
        const { error: dbError } = await supabase
          .from('video_generation_jobs')
          .select('id')
          .limit(1);
        if (dbError) {
          const body = { status: 'unhealthy', reason: 'db unreachable', detail: dbError.message };
          res.writeHead(503);
          res.end(JSON.stringify(body));
          break;
        }
      } catch (pingErr) {
        const body = { status: 'unhealthy', reason: 'db unreachable', detail: String(pingErr) };
        res.writeHead(503);
        res.end(JSON.stringify(body));
        break;
      }
      const body = buildHealthResponse(vitals);
      res.writeHead(200);
      res.end(JSON.stringify(body));
      break;
    }

    case "/ready":
    case "/readyz": {
      if (!vitals.accepting) {
        res.writeHead(503);
        res.end(JSON.stringify({ status: "not_ready", reason: "shutting_down" }));
        break;
      }
      const realtimeDead = vitals.realtimeStatus === 'CHANNEL_ERROR' || vitals.realtimeStatus === 'TIMED_OUT';
      const pollStaleMs = vitals.lastPollAt
        ? Date.now() - new Date(vitals.lastPollAt).getTime()
        : vitals.uptimeSeconds * 1000;
      const pollLoopDead = pollStaleMs > vitals.pollStaleThresholdMs;
      if (realtimeDead && pollLoopDead) {
        res.writeHead(503);
        res.end(JSON.stringify({
          status: "not_ready",
          reason: "all_delivery_paths_dead",
          realtimeStatus: vitals.realtimeStatus,
          pollStaleSec: Math.round(pollStaleMs / 1000),
        }));
        break;
      }
      if (pollLoopDead) {
        res.writeHead(503);
        res.end(JSON.stringify({
          status: "not_ready",
          reason: "poll_loop_dead",
          pollStaleSec: Math.round(pollStaleMs / 1000),
          realtimeStatus: vitals.realtimeStatus,
        }));
        break;
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        status: "ready",
        activeJobs: vitals.activeJobs,
        realtimeStatus: vitals.realtimeStatus,
        pollStaleSec: Math.round(pollStaleMs / 1000),
      }));
      break;
    }

    case "/metrics": {
      const accept = req.headers.accept ?? "";
      const wantsPrometheus =
        accept.includes("text/plain") ||
        accept.includes("application/openmetrics-text") ||
        req.url?.includes("format=prometheus");
      if (wantsPrometheus) {
        res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        res.writeHead(200);
        res.end(buildMetricsPrometheus(vitals));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify(buildMetricsJson(vitals)));
      }
      break;
    }

    default: {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found", endpoints: ["/health", "/ready", "/metrics"] }));
    }
  }
}

/**
 * Start the health-check HTTP server.
 *
 * @param getVitals  Callback that returns current worker vitals.
 * @param port       Port to bind (default: HEALTH_PORT env or 10000).
 * @returns          The http.Server instance.
 */
export function startHealthServer(
  getVitals: VitalsProvider,
  port: number = parseInt(process.env.HEALTH_PORT || process.env.PORT || "10000", 10)
): http.Server {
  vitalsProvider = getVitals;

  if (process.env.NODE_ENV === 'production' && !process.env.HEALTH_AUTH_TOKEN) {
    console.warn('[HealthServer] ⚠️  HEALTH_AUTH_TOKEN is not set — /metrics will return 401 in production until it is configured.');
  }

  server = http.createServer(handleRequest);

  server.listen(port, "0.0.0.0", () => {
    console.log(`[HealthServer] Listening on 0.0.0.0:${port} — /health /ready /metrics`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[HealthServer] Port ${port} in use — health server disabled`);
    } else {
      console.error(`[HealthServer] Server error:`, err.message);
    }
  });

  return server;
}

/**
 * Gracefully close the health server.
 * Stops accepting new connections and waits for existing ones to finish.
 */
export async function stopHealthServer(): Promise<void> {
  if (!server) return;
  return new Promise((resolve) => {
    server!.close(() => {
      console.log("[HealthServer] Stopped");
      server = null;
      resolve();
    });
    // Force-close after 5s if connections don't drain
    setTimeout(() => {
      if (server) {
        console.warn("[HealthServer] Force-closing after timeout");
        server = null;
        resolve();
      }
    }, 5000);
  });
}
