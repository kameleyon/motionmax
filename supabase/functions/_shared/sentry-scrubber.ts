/**
 * Shared Sentry PII scrubber for Supabase Edge Functions (Deno runtime).
 *
 * Mirror of worker/src/lib/sentry-scrubber.ts and src/lib/sentry-scrubber.ts.
 * Keep the regex tables in sync across all three runtimes.
 *
 * Wired into Sentry.init via `beforeSend: scrubSentryEvent`.
 */

// deno-lint-ignore-file no-explicit-any

// ── Patterns ────────────────────────────────────────────────────────────────

const EMAIL_RE = /[\w._%+-]+@[\w.-]+\.[a-z]{2,}/gi;
const STRIPE_ID_RE = /\b(pm|pi|cus|sub|seti|src|ch|in|sk_live|sk_test|rk_live|rk_test|whsec)_[A-Za-z0-9]{14,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}/gi;
const GOOGLE_OAUTH_RE = /\bya29\.[A-Za-z0-9_-]{20,}\b/g;
const META_OAUTH_RE = /\b(IGAA|IGQV|EAA)[A-Za-z0-9_-]{30,}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const REDACT_KEY_RE =
  /^(password|api_?key|secret|token|authorization|cookie|set-cookie|x-api-key|stripe-signature|refresh_token|access_token|client_secret|service_role_key|supabase_service_role_key)$/i;

const CARD_CONTEXT_KEY_RE = /(card|payment|stripe|last_?4|cc_?num|cardnumber)/i;
const FOUR_DIGIT_RE = /\b\d{4}\b/g;

const NOISE_MESSAGE_RE = [
  /AbortError: (The user aborted a request|signal is aborted)/i,
  /TypeError: (Failed to fetch|NetworkError when attempting to fetch)/i,
  /^cancelled$/i,
];

const NOISE_URL_RE = [
  /\/favicon\.ico$/,
  /\/robots\.txt$/,
  /\/\.well-known\//,
];

let redactionCount = 0;

function logRedaction(reason: string): void {
  redactionCount += 1;
  if (Deno.env.get("DENO_DEPLOYMENT_ID") === undefined && redactionCount % 50 === 1) {
    console.debug(`[sentry-scrubber] redacted ${reason} (count=${redactionCount})`);
  }
}

function scrubString(value: string, parentKey?: string): string {
  if (!value) return value;
  let out = value;

  if (EMAIL_RE.test(out)) { out = out.replace(EMAIL_RE, "<REDACTED:email>"); logRedaction("email"); }
  if (STRIPE_ID_RE.test(out)) { out = out.replace(STRIPE_ID_RE, "<REDACTED:stripe_id>"); logRedaction("stripe_id"); }
  if (JWT_RE.test(out)) { out = out.replace(JWT_RE, "<REDACTED:jwt>"); logRedaction("jwt"); }
  if (BEARER_RE.test(out)) { out = out.replace(BEARER_RE, "Bearer <REDACTED:token>"); logRedaction("bearer"); }
  if (GOOGLE_OAUTH_RE.test(out)) { out = out.replace(GOOGLE_OAUTH_RE, "<REDACTED:google_oauth>"); logRedaction("google_oauth"); }
  if (META_OAUTH_RE.test(out)) { out = out.replace(META_OAUTH_RE, "<REDACTED:meta_oauth>"); logRedaction("meta_oauth"); }
  if (parentKey && CARD_CONTEXT_KEY_RE.test(parentKey) && FOUR_DIGIT_RE.test(out)) {
    out = out.replace(FOUR_DIGIT_RE, "****");
    logRedaction("card_last4");
  }
  if (parentKey && /url|path|referer|location/i.test(parentKey)) {
    out = out.replace(UUID_RE, "<REDACTED:uuid>");
  }

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

/**
 * Sentry `beforeSend` callback for Edge Functions.
 * Returns scrubbed event, or `null` to drop known-noise events.
 */
export function scrubSentryEvent(event: any, _hint?: any): any | null {
  try {
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

    if (event?.user) {
      const { id, ip_address: _ip, email: _email, username: _u, ...rest } = event.user;
      event.user = id ? { id, ...scrubValue(rest) as Record<string, unknown> } : undefined;
    }

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
    console.error("[sentry-scrubber] scrubber crashed; dropping event", err);
    return null;
  }
}
