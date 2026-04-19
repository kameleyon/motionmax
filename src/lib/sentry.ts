/**
 * Sentry error-tracking bootstrap.
 *
 * Call `initSentry()` once at app startup (before React renders).
 * Session Replay is NOT registered here — it requires analytics consent
 * (GDPR). Call `grantAnalyticsConsent()` after the user accepts cookies
 * to enable replay.
 *
 * Also wires up the structured logger's `registerErrorSink` hook so
 * every `slog.warn()` / `slog.error()` is forwarded to Sentry.
 *
 * ── Required Sentry alert rules (configure in Sentry Dashboard → Alerts) ──
 *
 * 1. Error spike — "New issue or regression"
 *    Trigger: any new unhandled exception (or regressed issue)
 *    Destination: email + Slack #alerts-prod
 *    Environments: production
 *
 * 2. High error rate — "Number of events"
 *    Trigger: >50 errors in 1 hour across all issues
 *    Destination: Slack #alerts-prod
 *    Environments: production
 *
 * 3. Performance — "Transaction duration"
 *    Trigger: p95 LCP > 4 000 ms on /app routes
 *    Destination: email
 *    Environments: production
 *
 * 4. Worker edge-function errors (via Sentry Deno SDK, if configured)
 *    DSN: set via `supabase secrets set SENTRY_DSN=…`
 *    Alert: any unhandled exception in generate-cinematic or stripe-webhook
 *    Destination: Slack #alerts-billing (for stripe-webhook)
 *
 * Required environment variables:
 *   VITE_SENTRY_DSN      — frontend (Vercel env)
 *   SENTRY_AUTH_TOKEN    — source-map upload (CI/CD only)
 *   SENTRY_ORG           — your Sentry org slug
 *   SENTRY_PROJECT       — your Sentry project slug
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
      // browserTracingIntegration is legitimate-interest (performance monitoring,
      // no session recording). replayIntegration is added later via
      // grantAnalyticsConsent() once the user explicitly accepts cookies.
      Sentry.browserTracingIntegration(),
    ],
    // Performance: sample 10 % of transactions in production
    tracesSampleRate: IS_PROD ? 0.1 : 1.0,
    // Replay rates start at 0; grantAnalyticsConsent() enables on-error replay.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
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

/**
 * Enable Sentry Session Replay after the user grants analytics consent.
 * Safe to call multiple times — a guard prevents double-registration.
 */
let replayEnabled = false;
export function grantAnalyticsConsent(): void {
  if (!DSN || replayEnabled) return;
  replayEnabled = true;
  Sentry.addIntegration(Sentry.replayIntegration());
  // Activate on-error replay (10 % of error sessions) now that consent is given.
  Sentry.getClient()?.getOptions && Object.assign(
    Sentry.getClient()!.getOptions(),
    { replaysOnErrorSampleRate: 0.1 },
  );
}
