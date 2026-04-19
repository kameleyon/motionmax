/**
 * Lightweight structured JSON logger for the worker process.
 *
 * Emits NDJSON lines to stdout/stderr so Render and other cloud log
 * aggregators can ingest them with jobId/userId correlation fields.
 *
 * Usage:
 *   import { wlog } from "../lib/workerLogger.js";
 *   wlog.info("Scene encoded", { jobId, sceneIdx: 2 });
 *   const jlog = wlog.child({ jobId, userId, projectId });
 *   jlog.warn("Retrying ffmpeg", { attempt: 2 });
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
const MIN_LEVEL = LEVELS[envLevel] ?? LEVELS.info;

function emit(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  if (LEVELS[level] < MIN_LEVEL) return;

  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...ctx,
  });

  if (level === "error" || level === "warn") {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

export interface WorkerLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(baseCtx: Record<string, unknown>): WorkerLogger;
}

function makeLogger(baseCtx: Record<string, unknown> = {}): WorkerLogger {
  return {
    debug: (msg, ctx) => emit("debug", msg, { ...baseCtx, ...ctx }),
    info:  (msg, ctx) => emit("info",  msg, { ...baseCtx, ...ctx }),
    warn:  (msg, ctx) => emit("warn",  msg, { ...baseCtx, ...ctx }),
    error: (msg, ctx) => emit("error", msg, { ...baseCtx, ...ctx }),
    child: (ctx) => makeLogger({ ...baseCtx, ...ctx }),
  };
}

/** Root logger — use `.child({ jobId, userId, projectId })` for per-job loggers. */
export const wlog: WorkerLogger = makeLogger({ component: "worker" });
