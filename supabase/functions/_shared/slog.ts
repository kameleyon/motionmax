/**
 * Structured JSON logger for Supabase Edge Functions (Deno).
 *
 * Every line is a JSON object — machine-readable by Supabase log drains.
 * Fields: ts, level, fn (function name), reqId (request ID), msg, + any ctx.
 *
 * Usage:
 *   import { createFnLogger } from "../_shared/slog.ts";
 *   const log = createFnLogger("stripe-webhook");
 *   log.info("Event received", { type: event.type, reqId });
 *   log.error("Handler failed", { eventId }, err);
 *
 * Log level is controlled via LOG_LEVEL env (debug|info|warn|error; default: info).
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_VALUE: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const envLevel = (Deno.env.get("LOG_LEVEL") ?? "info").toLowerCase() as Level;
const MIN_LEVEL = LEVEL_VALUE[envLevel] ?? LEVEL_VALUE.info;

function emit(
  fn: string,
  level: Level,
  msg: string,
  ctx?: Record<string, unknown>,
  err?: unknown,
): void {
  if (LEVEL_VALUE[level] < MIN_LEVEL) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    fn,
    msg,
  };

  if (ctx && Object.keys(ctx).length > 0) {
    Object.assign(entry, ctx);
  }

  if (err instanceof Error) {
    entry.err = err.message;
    entry.stack = err.stack;
  } else if (err !== undefined) {
    entry.err = String(err);
  }

  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface FnLogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>, err?: unknown): void;
  error(msg: string, ctx?: Record<string, unknown>, err?: unknown): void;
  /** Return a child logger with extra fixed context merged on every call. */
  child(extraCtx: Record<string, unknown>): FnLogger;
}

/**
 * Create a structured logger scoped to a specific edge function.
 * Optionally pass a `reqId` for per-request correlation.
 */
export function createFnLogger(
  fn: string,
  fixedCtx?: Record<string, unknown>,
): FnLogger {
  const merged = fixedCtx ?? {};
  return {
    debug: (msg, ctx) => emit(fn, "debug", msg, { ...merged, ...ctx }),
    info:  (msg, ctx) => emit(fn, "info",  msg, { ...merged, ...ctx }),
    warn:  (msg, ctx, err) => emit(fn, "warn",  msg, { ...merged, ...ctx }, err),
    error: (msg, ctx, err) => emit(fn, "error", msg, { ...merged, ...ctx }, err),
    child: (extraCtx) => createFnLogger(fn, { ...merged, ...extraCtx }),
  };
}
