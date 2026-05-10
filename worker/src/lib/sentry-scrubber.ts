/**
 * Shared Sentry PII scrubber for the Node.js worker.
 *
 * Wired into Sentry.init via `beforeSend: scrubSentryEvent`.
 *
 * What it does
 * ────────────
 * 1. Recursively walks every place Sentry stores user-supplied data:
 *      - event.message
 *      - event.request.{data,query_string,cookies,headers}
 *      - event.extra
 *      - event.contexts
 *      - event.tags
 *      - event.user (drop email/ip; keep id)
 *      - event.exception.values[*].value
 *      - event.breadcrumbs[*].{message,data}
 *
 * 2. Replaces matching strings with `<REDACTED:type>` so the event
 *    still has shape but no leaked secret.
 *
 * 3. Returns `null` for known-noise events (user-cancelled fetch,
 *    static-asset 404) so we don't burn Sentry quota on them.
 *
 * 4. Logs to console (NEVER to Sentry) when redaction happens, so
 *    devs can still debug locally.
 *
 * Three runtimes share this scrubber by parallel implementation:
 *   - worker  → this file
 *   - edge fn → supabase/functions/_shared/sentry-scrubber.ts
 *   - browser → src/lib/sentry-scrubber.ts
 *
 * Keep the regex tables in sync across all three.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Patterns ────────────────────────────────────────────────────────────────

const EMAIL_RE = /[\w._%+-]+@[\w.-]+\.[a-z]{2,}/gi;
// Stripe object IDs. The Stripe ID format is `<prefix>_<24+ chars>`.
const STRIPE_ID_RE = /\b(pm|pi|cus|sub|seti|src|ch|in|sk_live|sk_test|rk_live|rk_test|whsec)_[A-Za-z0-9]{14,}\b/g;
// Compact JWT (eyJ… header.payload.signature). Three base64url segments.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
// Bearer / Basic auth tokens that may leak into request data.
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}/gi;
// Google OAuth refresh token shape.
const GOOGLE_OAUTH_RE = /\bya29\.[A-Za-z0-9_-]{20,}\b/g;
// Instagram / Threads long-lived tokens (start with IGAA, IGQV, etc.).
const META_OAUTH_RE = /\b(IGAA|IGQV|EAA)[A-Za-z0-9_-]{30,}\b/g;
// UUID v4-ish (used in URL paths).
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Field names whose value should ALWAYS be wholly redacted, regardless of content.
const REDACT_KEY_RE =
  /^(password|api_?key|secret|token|authorization|cookie|set-cookie|x-api-key|stripe-signature|refresh_token|access_token|client_secret|service_role_key|supabase_service_role_key)$/i;

// Card-context field names. When we see `last4` / `card_number` / etc., even
// 4-digit strings get redacted. Outside this context we leave 4-digit numbers alone.
const CARD_CONTEXT_KEY_RE = /(card|payment|stripe|last_?4|cc_?num|cardnumber)/i;
const FOUR_DIGIT_RE = /\b\d{4}\b/g;

// Known-noise messages — we drop these entirely (return null from beforeSend).
const NOISE_MESSAGE_RE = [
  /AbortError: (The user aborted a request|signal is aborted)/i,
  /TypeError: (Failed to fetch|NetworkError when attempting to fetch)/i,
  /ResizeObserver loop limit exceeded/i,
  /Non-Error promise rejection captured with value: undefined/i,
  /^cancelled$/i,
];

// Asset paths that 404 in production but aren't real bugs.
const NOISE_URL_RE = [
  /\/favicon\.ico$/,
  /\/apple-touch-icon.*\.png$/,
  /\/robots\.txt$/,
  /\/\.well-known\//,
];

// ── Redaction primitives ────────────────────────────────────────────────────

let redactionCount = 0;

function logRedaction(reason: string): void {
  redactionCount += 1;
  // Only log every 50th redaction to avoid spam in dev. We deliberately use
  // console (NOT Sentry) so this never feeds back into the event pipeline.
  if (process.env.NODE_ENV !== "production" && redactionCount % 50 === 1) {
    // eslint-disable-next-line no-console
    console.debug(`[sentry-scrubber] redacted ${reason} (count=${redactionCount})`);
  }
}

function scrubString(value: string, parentKey?: string): string {
  if (!value) return value;
  let out = value;

  if (EMAIL_RE.test(out)) {
    out = out.replace(EMAIL_RE, "<REDACTED:email>");
    logRedaction("email");
  }
  if (STRIPE_ID_RE.test(out)) {
    out = out.replace(STRIPE_ID_RE, "<REDACTED:stripe_id>");
    logRedaction("stripe_id");
  }
  if (JWT_RE.test(out)) {
    out = out.replace(JWT_RE, "<REDACTED:jwt>");
    logRedaction("jwt");
  }
  if (BEARER_RE.test(out)) {
    out = out.replace(BEARER_RE, "Bearer <REDACTED:token>");
    logRedaction("bearer");
  }
  if (GOOGLE_OAUTH_RE.test(out)) {
    out = out.replace(GOOGLE_OAUTH_RE, "<REDACTED:google_oauth>");
    logRedaction("google_oauth");
  }
  if (META_OAUTH_RE.test(out)) {
    out = out.replace(META_OAUTH_RE, "<REDACTED:meta_oauth>");
    logRedaction("meta_oauth");
  }
  if (parentKey && CARD_CONTEXT_KEY_RE.test(parentKey) && FOUR_DIGIT_RE.test(out)) {
    out = out.replace(FOUR_DIGIT_RE, "****");
    logRedaction("card_last4");
  }
  // UUIDs in URL-like strings only (preserve plain UUID tags).
  if (parentKey && /url|path|referer|location/i.test(parentKey)) {
    out = out.replace(UUID_RE, "<REDACTED:uuid>");
  }

  // Reset regex .lastIndex (these are stateful 'g' regexes).
  EMAIL_RE.lastIndex = 0;
  STRIPE_ID_RE.lastIndex = 0;
  JWT_RE.lastIndex = 0;
  BEARER_RE.lastIndex = 0;
  GOOGLE_OAUTH_RE.lastIndex = 0;
  META_OAUTH_RE.lastIndex = 0;
  FOUR_DIGIT_RE.lastIndex = 0;
  UUID_RE.lastIndex = 0;

  return out;
}

function scrubValue(value: unknown, parentKey?: string, depth = 0): unknown {
  if (value == null || depth > 8) return value;
  if (typeof value === "string") return scrubString(value, parentKey);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, parentKey, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEY_RE.test(k)) {
        out[k] = "<REDACTED:secret>";
        logRedaction(`key:${k}`);
        continue;
      }
      out[k] = scrubValue(v, k, depth + 1);
    }
    return out;
  }

  return value;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Sentry `beforeSend` callback. Returns the scrubbed event, or `null` to
 * drop known-noise events.
 */
export function scrubSentryEvent(event: any, _hint?: any): any | null {
  try {
    // 1. Drop noise events outright.
    const message: string | undefined = event?.message ?? event?.exception?.values?.[0]?.value;
    if (typeof message === "string") {
      for (const re of NOISE_MESSAGE_RE) {
        if (re.test(message)) return null;
      }
    }
    const url: string | undefined = event?.request?.url;
    if (typeof url === "string") {
      for (const re of NOISE_URL_RE) {
        if (re.test(url)) return null;
      }
    }

    // 2. Drop user PII fields, keep stable id.
    if (event?.user) {
      const { id, ip_address: _ip, email: _email, username: _u, ...rest } = event.user;
      event.user = id ? { id, ...scrubValue(rest) as Record<string, unknown> } : undefined;
    }

    // 3. Recursive walk on common containers.
    if (event?.message) event.message = scrubString(String(event.message));
    if (event?.request) event.request = scrubValue(event.request) as any;
    if (event?.extra) event.extra = scrubValue(event.extra) as any;
    if (event?.contexts) event.contexts = scrubValue(event.contexts) as any;
    if (event?.tags) event.tags = scrubValue(event.tags) as any;

    if (Array.isArray(event?.exception?.values)) {
      event.exception.values = event.exception.values.map((v: any) => ({
        ...v,
        value: typeof v.value === "string" ? scrubString(v.value) : v.value,
      }));
    }

    if (Array.isArray(event?.breadcrumbs)) {
      event.breadcrumbs = event.breadcrumbs.map((b: any) => ({
        ...b,
        message: typeof b.message === "string" ? scrubString(b.message) : b.message,
        data: b.data ? scrubValue(b.data) : b.data,
      }));
    }

    return event;
  } catch (err) {
    // If the scrubber itself crashes, drop the event rather than send leaking data.
    // eslint-disable-next-line no-console
    console.error("[sentry-scrubber] scrubber crashed; dropping event", err);
    return null;
  }
}

// Exported for unit tests in case we add them later.
export const __test__ = { scrubString, scrubValue };
