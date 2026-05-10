/**
 * Sentry error-tracking bootstrap (browser).
 *
 * Call `initSentry()` once at app startup (before React renders).
 * Session Replay is NOT registered here — it requires analytics consent
 * (GDPR). Call `grantAnalyticsConsent()` after the user accepts cookies
 * to enable replay.
 *
 * Also wires up the structured logger's `registerErrorSink` hook so
 * every `slog.warn()` / `slog.error()` is forwarded to Sentry.
 *
 * Alert rules: see `iac/sentry/alert-rules.json` (committed as code).
 * Setup runbook: see `docs/observability-setup.md`.
 *
 * Required environment variables:
 *   VITE_SENTRY_DSN      — frontend (Vercel env)
 *   SENTRY_AUTH_TOKEN    — source-map upload (CI/CD only)
 *   SENTRY_ORG           — your Sentry org slug
 *   SENTRY_PROJECT       — your Sentry project slug
 */

import * as Sentry from "@sentry/react";
import { registerErrorSink } from "@/lib/structuredLogger";
import { scrubSentryEvent } from "@/lib/sentry-scrubber";

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
    // The cookie banner (B-NEW-9) calls grantAnalyticsConsent() only after
    // explicit user opt-in, satisfying the consent gate for replay.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    // Only send errors from our own code (including Vercel preview deployments)
    allowUrls: [/motionmax\.io/, /\.vercel\.app/, /localhost/],
    // PII scrubbing — see src/lib/sentry-scrubber.ts. Strips emails, Stripe IDs,
    // JWTs, OAuth tokens, last4 in card contexts, and drops noise events.
    beforeSend: scrubSentryEvent,
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
  const sentryClient = Sentry.getClient();
  if (sentryClient?.getOptions) {
    Object.assign(sentryClient.getOptions(), { replaysOnErrorSampleRate: 0.1 });
  }
}
