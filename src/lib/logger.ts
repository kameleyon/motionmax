/**
 * Frontend structured logger.
 *
 * - Development: all levels printed to console
 * - Production: only warn + error (debug/info suppressed)
 *
 * Usage:
 *   import { logger } from "@/lib/logger";
 *   logger.debug("Pipeline started", { projectType, length });
 *   logger.warn("Rate limited", { scene: 3 });
 *   logger.error("Generation failed", error);
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const IS_DEV = import.meta.env.DEV;

/** Minimum level printed in each environment */
const MIN_LEVEL: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const PROD_MIN_LEVEL = MIN_LEVEL.warn; // 2 → only warn + error in prod

function shouldLog(level: LogLevel): boolean {
  if (IS_DEV) return true;
  return MIN_LEVEL[level] >= PROD_MIN_LEVEL;
}

function createLogger(prefix?: string) {
  const tag = prefix ? `[${prefix}]` : "";

  return {
    debug(...args: unknown[]): void {
      if (!shouldLog("debug")) return;
      console.log(tag, ...args);
    },

    info(...args: unknown[]): void {
      if (!shouldLog("info")) return;
      console.log(tag, ...args);
    },

    warn(...args: unknown[]): void {
      if (!shouldLog("warn")) return;
      console.warn(tag, ...args);
    },

    error(...args: unknown[]): void {
      if (!shouldLog("error")) return;
      console.error(tag, ...args);
      // Bridge to Sentry in production
      if (!IS_DEV) {
        import("@sentry/react").then((Sentry) => {
          Sentry.captureException(
            args[0] instanceof Error ? args[0] : new Error(String(args[0])),
            { tags: { scope: prefix || "app" }, extra: { args: args.slice(1) } }
          );
        }).catch(() => {});
      }
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
