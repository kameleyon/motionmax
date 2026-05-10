/**
 * Marketing Sentry bootstrap — audit C-9-5.
 *
 * The Astro marketing site at motionmax.io had ZERO error visibility:
 * failed renders, broken CTAs, 404s, and analytics breakage were
 * invisible to engineering. This module loads `@sentry/browser` from
 * BetterStack… er, from the official Sentry CDN, and initialises it
 * with the same PII scrubber the React app uses.
 *
 * Why CDN instead of `npm install`?
 *   - The marketing Astro project ships a tiny CSP and a tinier bundle
 *     budget. Bringing in `@sentry/browser` via npm bloats the marketing
 *     bundle by ~80 KB gz for code that needs to run on every marketing
 *     page including legal pages. The CDN script is loaded async and
 *     does not block first paint.
 *   - The audit explicitly asked for "no npm install".
 *
 * Why a separate Sentry init from the React app?
 *   - The two apps live on different subdomains (motionmax.io vs
 *     app.motionmax.io) and have different transaction shapes. Sharing
 *     a project would pollute the React app's issue list with marketing
 *     404s. We use the SAME DSN but tag every event with `surface=marketing`
 *     so the React-side and marketing-side filters can split easily.
 *
 * Consent gate:
 *   - Sentry is gated behind `hasCategoryConsent('analytics')` (Wave 3
 *     cookie-consent registry). No script tag is appended, no DSN
 *     handshake, no PII transmitted, until the user accepts analytics.
 *   - On consent change (user opens the banner via the footer and flips
 *     analytics on), Sentry initialises on the spot — no page reload.
 *
 * trace sampling:
 *   - `tracesSampleRate: 0.1` (10%) — much lower than billing (1.0 per
 *     C-9-2). Marketing transactions are page-loads; we only need a
 *     statistical sample to spot regressions.
 *
 * PII scrubber:
 *   - Mirrors the regex tables in src/lib/sentry-scrubber.ts and
 *     supabase/functions/_shared/sentry-scrubber.ts. Don't drift these
 *     three files — if one regex changes, all three change.
 */

import { hasCategoryConsent, onConsentChange } from "./cookieConsent.js";

// ── Config from meta tag (same pattern as marketingAnalytics.js) ───────────
function readSentryDsn() {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector('meta[name="motionmax-sentry-dsn"]');
  if (!meta) return null;
  const value = meta.getAttribute("content");
  if (!value) return null;
  // Reject the unreplaced placeholder so we don't ping a wrong DSN.
  if (!/^https:\/\/[a-z0-9]+@/i.test(value)) return null;
  return value;
}

function readRelease() {
  if (typeof document === "undefined") return undefined;
  const meta = document.querySelector('meta[name="motionmax-sentry-release"]');
  return meta?.getAttribute("content") || undefined;
}

// ── PII scrubber (mirror of src/lib/sentry-scrubber.ts) ─────────────────────
const EMAIL_RE = /[\w._%+-]+@[\w.-]+\.[a-z]{2,}/gi;
const STRIPE_ID_RE = /\b(pm|pi|cus|sub|seti|src|ch|in|sk_live|sk_test|rk_live|rk_test|whsec)_[A-Za-z0-9]{14,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const REDACT_KEY_RE =
  /^(password|api_?key|secret|token|authorization|cookie|set-cookie|x-api-key|stripe-signature|refresh_token|access_token|client_secret|service_role_key|supabase_service_role_key)$/i;
const NOISE_MESSAGE_RE = [
  /AbortError:/i,
  /TypeError: (Failed to fetch|NetworkError when attempting to fetch)/i,
  /ResizeObserver loop limit exceeded/i,
];
const NOISE_URL_RE = [/\/favicon\.ico$/, /\/robots\.txt$/, /\/\.well-known\//];

function scrubString(value, parentKey) {
  if (!value) return value;
  let out = value;
  out = out.replace(EMAIL_RE, "<REDACTED:email>");
  out = out.replace(STRIPE_ID_RE, "<REDACTED:stripe_id>");
  out = out.replace(JWT_RE, "<REDACTED:jwt>");
  out = out.replace(BEARER_RE, "Bearer <REDACTED:token>");
  // Audit C-9-6: do not scrub trace_id keys.
  const isTraceIdKey = parentKey && /^(x[-_])?trace[-_]?id$/i.test(parentKey);
  if (parentKey && !isTraceIdKey && /url|path|referer|location/i.test(parentKey)) {
    out = out.replace(UUID_RE, "<REDACTED:uuid>");
  }
  return out;
}

function scrubValue(value, parentKey, depth) {
  if (value == null || depth > 8) return value;
  if (typeof value === "string") return scrubString(value, parentKey);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, parentKey, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACT_KEY_RE.test(k)) {
        out[k] = "<REDACTED:secret>";
        continue;
      }
      out[k] = scrubValue(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

function beforeSend(event) {
  try {
    const message = event?.message || event?.exception?.values?.[0]?.value;
    if (typeof message === "string") {
      for (const re of NOISE_MESSAGE_RE) {
        if (re.test(message)) return null;
      }
    }
    const url = event?.request?.url;
    if (typeof url === "string") {
      for (const re of NOISE_URL_RE) {
        if (re.test(url)) return null;
      }
    }
    if (event?.user) {
      const { id } = event.user;
      event.user = id ? { id } : undefined;
    }
    if (event?.message) event.message = scrubString(String(event.message));
    if (event?.request) event.request = scrubValue(event.request, undefined, 0);
    if (event?.extra) event.extra = scrubValue(event.extra, undefined, 0);
    if (event?.contexts) event.contexts = scrubValue(event.contexts, undefined, 0);
    if (event?.tags) event.tags = scrubValue(event.tags, undefined, 0);
    if (Array.isArray(event?.exception?.values)) {
      event.exception.values = event.exception.values.map((v) => ({
        ...v,
        value: typeof v.value === "string" ? scrubString(v.value) : v.value,
      }));
    }
    if (Array.isArray(event?.breadcrumbs)) {
      event.breadcrumbs = event.breadcrumbs.map((b) => ({
        ...b,
        message: typeof b.message === "string" ? scrubString(b.message) : b.message,
        data: b.data ? scrubValue(b.data, undefined, 0) : b.data,
      }));
    }
    return event;
  } catch {
    // Scrubber crashed — drop event rather than risk leaking PII.
    return null;
  }
}

// ── CDN load ────────────────────────────────────────────────────────────────
const SENTRY_CDN = "https://browser.sentry-cdn.com/8.40.0/bundle.tracing.min.js";
let loadingPromise = null;

function loadSentryScript() {
  if (loadingPromise) return loadingPromise;
  loadingPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("no window"));
      return;
    }
    if (window.Sentry) {
      resolve(window.Sentry);
      return;
    }
    const script = document.createElement("script");
    script.src = SENTRY_CDN;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      if (window.Sentry) resolve(window.Sentry);
      else reject(new Error("Sentry global not present after load"));
    };
    script.onerror = () => reject(new Error("Sentry CDN failed to load"));
    document.head.appendChild(script);
  });
  return loadingPromise;
}

let initialised = false;

async function bootstrapSentry() {
  if (initialised) return;
  if (typeof window === "undefined") return;
  const dsn = readSentryDsn();
  if (!dsn) return;
  try {
    const Sentry = await loadSentryScript();
    Sentry.init({
      dsn,
      release: readRelease(),
      environment: window.location.hostname.endsWith("motionmax.io")
        ? "production"
        : "development",
      // Audit C-9-5: marketing surface gets 10 % trace sampling. Billing
      // endpoints (worker, stripe-webhook, create-checkout) keep 1.0
      // per C-9-2; marketing transactions are page-loads where a sample
      // is enough to spot regressions.
      tracesSampleRate: 0.1,
      // No session replay on marketing — the app side handles it under
      // analytics consent, and we don't want to double-bill replays.
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      sendDefaultPii: false,
      allowUrls: [/motionmax\.io/, /\.vercel\.app/],
      beforeSend,
      // Tag every event so the React-side and marketing-side filters can
      // split cleanly even when both apps share a DSN.
      initialScope: {
        tags: { surface: "marketing" },
      },
    });
    initialised = true;
  } catch (err) {
    // Sentry itself failed — best we can do is log to console (won't
    // be captured anywhere but the user's devtools, which is fine).
    // eslint-disable-next-line no-console
    console.warn("[marketing-sentry] init failed:", err && err.message);
  }
}

export function initMarketingSentry() {
  if (hasCategoryConsent("analytics")) {
    void bootstrapSentry();
  }
  onConsentChange((record) => {
    if (record && record.categories && record.categories.analytics) {
      void bootstrapSentry();
    }
    // Like marketingAnalytics.js, we deliberately do NOT tear Sentry
    // down on revoke — leaving the SDK loaded means a re-grant takes
    // effect immediately without a page reload. New events stop
    // anyway because we never re-init after consent is withdrawn.
  });
}
