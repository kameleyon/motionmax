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

  const SENSITIVE_KEY_RE = /password|token|email|jwt|key|secret/i;

  function scrubSensitive(obj: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!obj) return obj;
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, SENSITIVE_KEY_RE.test(k) ? "[Redacted]" : v])
    );
  }

  Sentry.init({
    dsn: DSN,
    environment: IS_PROD ? "production" : "development",
    release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration(),
    ],
    // Performance: sample 10 % of transactions in production
    tracesSampleRate: IS_PROD ? 0.1 : 1.0,
    // No session replay; capture replay only on errors (10 % of error sessions)
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0.1,
    // Only send errors from our own code (including Vercel preview deployments)
    allowUrls: [/motionmax\.io/, /\.vercel\.app/, /localhost/],
    beforeSend(event) {
      if (event.extra) event.extra = scrubSensitive(event.extra as Record<string, unknown>);
      if (event.request?.data && typeof event.request.data === "object") {
        event.request.data = scrubSensitive(event.request.data as Record<string, unknown>);
      }
      return event;
    },
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
