/**
 * Sentry error-tracking bootstrap.
 *
 * Call `initSentry()` once at app startup (before React renders).
 * Also wires up the structured logger's `registerErrorSink` hook so
 * every `slog.warn()` / `slog.error()` is forwarded to Sentry.
 */

import * as Sentry from "@sentry/react";
import { registerErrorSink } from "@/lib/structuredLogger";

const DSN = import.meta.env.VITE_SENTRY_DSN ?? "";
const IS_PROD = import.meta.env.PROD;

export function initSentry(): void {
  if (!DSN) {
    if (IS_PROD) {
      console.error(
        "[Sentry] VITE_SENTRY_DSN is not set! Production error tracking is DISABLED. " +
        "Set this environment variable in your deployment platform."
      );
    }
    return;
  }

  Sentry.init({
    dsn: DSN,
    environment: IS_PROD ? "production" : "development",
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration(),
    ],
    // Performance: sample 10 % of transactions in production
    tracesSampleRate: IS_PROD ? 0.1 : 1.0,
    // Session replay: 10 % normal, 100 % on error
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    // Only send errors from our own code
    allowUrls: [/motionmax\.io/, /localhost/],
  });

  // Bridge: forward structured logger warn/error → Sentry
  registerErrorSink((entry) => {
    const extra: Record<string, unknown> = { ...entry.ctx };
    if (entry.stack) extra._stack = entry.stack;

    if (entry.level === "error") {
      Sentry.captureException(
        entry.err ? new Error(entry.err) : new Error(entry.msg),
        { extra },
      );
    } else {
      Sentry.captureMessage(entry.msg, {
        level: entry.level === "warn" ? "warning" : "info",
        extra,
      });
    }
  });
}
