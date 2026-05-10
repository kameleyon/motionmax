/**
 * Production HTTP health-check server for Render / Railway (or any orchestrator).
 *
 * Exposes:
 *   GET /health        → 200 + minimal `{ status, timestamp }` for orchestrator probes
 *   GET /ready         → 200 if worker is accepting jobs, 503 if shutting down
 *   GET /health/full   → 200 + detailed vitals JSON (Bearer token required)
 *   GET /metrics       → 200 + JSON or Prometheus metrics (Bearer token required)
 *
 * Wave 6 hardening (Cipher §6 C-6-7 / C-6-8):
 *   - `/health` no longer leaks PID, Node version, hostname, memory, or job
 *     counts to anonymous callers (info-disclosure → targeted CVE matching).
 *     The full diagnostic moved to `/health/full` behind the same Bearer
 *     token as `/metrics`.
 *   - Bearer comparison now uses `crypto.timingSafeEqual` to close the
 *     timing oracle on `HEALTH_AUTH_TOKEN` that the old `!==` compare left
 *     open.
 *   - `Access-Control-Allow-Origin: *` removed — health probes come from
 *     Railway / internal monitoring, NOT from browsers. Dropping CORS
 *     means a malicious page in a victim's browser cannot fetch /health
 *     to fingerprint the worker.
 *
 * Uses Node.js built-in `http` — zero external dependencies.
 * Bind port via HEALTH_PORT env (default 10000 — Render's expected port).
 */
import http from "http";
import { timingSafeEqual } from "node:crypto";
import { supabase } from "./lib/supabase.js";

/**
 * Constant-time string equality.
 *
 * `a === b` and `a !== b` short-circuit on the first differing byte, which
 * lets a remote attacker recover the secret one byte at a time by measuring
 * response timing. `crypto.timingSafeEqual` always inspects every byte.
 *
 * Length mismatch is handled by inflating both buffers to the longer of the
 * two and returning `false`. The compare is still constant-time relative to
 * the length we end up comparing; we cannot fully hide a length difference
 * without also masking the response body length, but for fixed-length
 * tokens (HEALTH_AUTH_TOKEN is generated as a UUID / 32+ byte hex by ops)
 * the lengths always match in practice.
 *
 * Exported for unit tests (worker/src/lib/healthServer.test.ts) — kept
 * inline in this module so the only entry point is the request handler.
 */
export function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Pad to the longer length so timingSafeEqual still runs over a
    // constant number of bytes; result is forced to false regardless.
    const max = Math.max(ab.length, bb.length);
    const ap = Buffer.alloc(max);
    const bp = Buffer.alloc(max);
    ab.copy(ap);
    bb.copy(bp);
    // Run the compare for its timing characteristics, then return false.
    timingSafeEqual(ap, bp);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a Bearer-token-bearing Authorization header against
 * `HEALTH_AUTH_TOKEN`. Returns `true` if the request is authorized.
 *
 * Refuses in production if `HEALTH_AUTH_TOKEN` is unset (we'd otherwise
 * leak diagnostics to anyone). In dev/test with no token set, this is a
 * no-op so local curl probes still work.
 */
function isAuthorized(req: http.IncomingMessage): boolean {
  const expected = process.env.HEALTH_AUTH_TOKEN;
  if (!expected) {
    // In production we require the token; the caller checks NODE_ENV
    // and returns 401 before reaching here. Outside production, allow.
    return process.env.NODE_ENV !== "production";
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const provided = auth.slice("Bearer ".length);
  return safeEq(provided, expected);
}

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
  // Cipher §6 C-6-7: NO `Access-Control-Allow-Origin` header. The health
  // endpoints are consumed by Railway's orchestrator probes and internal
  // monitoring — neither needs CORS. Dropping the wildcard prevents
  // browser-based fingerprinting from arbitrary attacker-controlled pages.
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  const url = req.url?.split("?")[0] || "/";

  // Endpoints that require the Bearer token (info-disclosure surfaces).
  const requiresAuth = url === "/metrics" || url === "/health/full";

  if (requiresAuth) {
    const expected = process.env.HEALTH_AUTH_TOKEN;
    if (!expected && process.env.NODE_ENV === "production") {
      res.writeHead(401);
      res.end(
        JSON.stringify({
          error: "Endpoint requires HEALTH_AUTH_TOKEN to be set in production",
        })
      );
      return;
    }
    if (!isAuthorized(req)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
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
      // Cipher §6 C-6-7: minimal anonymous response. Just enough for
      // Railway / load-balancer health probes to decide "alive vs dead".
      // The detailed diagnostic (PID, Node version, memory, job counts)
      // moved to `/health/full` behind the Bearer token below.
      try {
        const { error: dbError } = await supabase
          .from('video_generation_jobs')
          .select('id')
          .limit(1);
        if (dbError) {
          // Do not echo the underlying DB error message — that itself is
          // an info-disclosure surface (driver version, host names, etc.).
          res.writeHead(503);
          res.end(JSON.stringify({ status: "unhealthy" }));
          break;
        }
      } catch {
        res.writeHead(503);
        res.end(JSON.stringify({ status: "unhealthy" }));
        break;
      }
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
        })
      );
      break;
    }

    case "/health/full":
    case "/healthz/full": {
      // Token-gated full diagnostic. Same shape as the pre-Wave-6
      // `/health` response — kept for internal monitoring dashboards.
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
      res.end(
        JSON.stringify({
          error: "Not found",
          endpoints: ["/health", "/ready", "/health/full", "/metrics"],
        })
      );
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
    console.warn(
      '[HealthServer] ⚠️  HEALTH_AUTH_TOKEN is not set — /metrics and /health/full ' +
        'will return 401 in production until it is configured. ' +
        'Public /health and /ready probes are unaffected.'
    );
  }

  server = http.createServer(handleRequest);

  server.listen(port, "0.0.0.0", () => {
    console.log(
      `[HealthServer] Listening on 0.0.0.0:${port} — /health /ready /health/full /metrics`
    );
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
