/**
 * Scoped frontend logger — thin adapter over structuredLogger.
 *
 * Both APIs now flow through the same JSON pipeline and Sentry error sink.
 * Prefer `slog` directly for new code; this module stays for backward compat.
 *
 * Usage:
 *   import { createScopedLogger } from "@/lib/logger";
 *   const log = createScopedLogger("Pipeline");
 *   log.debug("Scene rendered", { sceneIndex: 2 });
 *   log.error("Generation failed", err);
 */

import { slog } from "@/lib/structuredLogger";

function createLogger(scope?: string) {
  const ctx = scope ? { scope } : undefined;

  return {
    debug(msg: string, ...args: unknown[]): void {
      slog.debug(msg, args.length > 0 ? { ...ctx, args } : ctx);
    },
    info(msg: string, ...args: unknown[]): void {
      slog.info(msg, args.length > 0 ? { ...ctx, args } : ctx);
    },
    warn(msg: string, ...args: unknown[]): void {
      const err = args.find((a): a is Error => a instanceof Error);
      const rest = args.filter((a) => !(a instanceof Error));
      slog.warn(msg, rest.length > 0 ? { ...ctx, args: rest } : ctx, err);
    },
    error(msg: string, ...args: unknown[]): void {
      const err = args.find((a): a is Error => a instanceof Error);
      const rest = args.filter((a) => !(a instanceof Error));
      slog.error(msg, rest.length > 0 ? { ...ctx, args: rest } : ctx, err);
    },
  };
}

/** Default app logger */
export const logger = createLogger("MotionMax");

/**
 * Create a scoped logger with a custom prefix.
 * @example const log = createScopedLogger("Pipeline");
 */
export function createScopedLogger(scope: string) {
  return createLogger(scope);
}
