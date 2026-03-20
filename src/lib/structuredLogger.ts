/**
 * Structured logger with JSON output and error-reporting hooks.
 *
 * - Development: pretty-printed to console
 * - Production: JSON lines + optional external sink
 *
 * Usage:
 *   import { slog } from "@/lib/structuredLogger";
 *   slog.info("Generation started", { projectId, scenes: 5 });
 *   slog.error("Pipeline failed", { scene: 3 }, err);
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const IS_DEV = import.meta.env.DEV;
const PROD_MIN = LEVEL_VALUE.warn;

// ---------------------------------------------------------------------------
// Error-reporting sink (pluggable)
// ---------------------------------------------------------------------------

type ErrorSink = (payload: LogEntry) => void;

let _errorSink: ErrorSink | null = null;

/**
 * Register an external error-reporting callback (e.g. Sentry).
 * Call once at app bootstrap.
 */
export function registerErrorSink(sink: ErrorSink): void {
  _errorSink = sink;
}

// ---------------------------------------------------------------------------
// Log entry
// ---------------------------------------------------------------------------

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  ctx?: Record<string, unknown>;
  err?: string;
  stack?: string;
}

function buildEntry(
  level: LogLevel,
  msg: string,
  ctx?: Record<string, unknown>,
  error?: unknown,
): LogEntry {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (ctx && Object.keys(ctx).length > 0) entry.ctx = ctx;
  if (error instanceof Error) {
    entry.err = error.message;
    entry.stack = error.stack;
  } else if (error !== undefined) {
    entry.err = String(error);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Console output helpers
// ---------------------------------------------------------------------------

const CONSOLE_METHOD: Record<LogLevel, (...a: unknown[]) => void> = {
  debug: console.debug,
  info: console.log,
  warn: console.warn,
  error: console.error,
};

function emit(entry: LogEntry): void {
  const fn = CONSOLE_METHOD[entry.level];

  if (IS_DEV) {
    // Human-friendly output in dev
    const tag = `[${entry.level.toUpperCase()}]`;
    const parts: unknown[] = [tag, entry.msg];
    if (entry.ctx) parts.push(entry.ctx);
    if (entry.err) parts.push(`⚠ ${entry.err}`);
    fn(...parts);
    return;
  }

  // JSON line in production (consumed by log aggregators)
  fn(JSON.stringify(entry));
}

function shouldLog(level: LogLevel): boolean {
  if (IS_DEV) return true;
  return LEVEL_VALUE[level] >= PROD_MIN;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function log(
  level: LogLevel,
  msg: string,
  ctx?: Record<string, unknown>,
  error?: unknown,
): void {
  if (!shouldLog(level)) return;

  const entry = buildEntry(level, msg, ctx, error);
  emit(entry);

  // Forward errors / warnings to external sink
  if (_errorSink && LEVEL_VALUE[level] >= LEVEL_VALUE.warn) {
    try {
      _errorSink(entry);
    } catch {
      // Never let the sink crash the app
    }
  }
}

/** Structured logger singleton */
export const slog = {
  debug(msg: string, ctx?: Record<string, unknown>): void {
    log("debug", msg, ctx);
  },
  info(msg: string, ctx?: Record<string, unknown>): void {
    log("info", msg, ctx);
  },
  warn(msg: string, ctx?: Record<string, unknown>, error?: unknown): void {
    log("warn", msg, ctx, error);
  },
  error(msg: string, ctx?: Record<string, unknown>, error?: unknown): void {
    log("error", msg, ctx, error);
  },
};
