/**
 * Secure CORS configuration for Supabase Edge Functions
 *
 * SECURITY (B-NEW-3 / Shield S-003):
 *  - Never uses wildcard (*) for credentialed routes.
 *  - The allowlist is sourced from the ALLOWED_ORIGINS env var
 *    (comma-separated). Hard-coded localhost origins are NEVER
 *    served in production.
 *  - When the request Origin is not in the allowlist, the
 *    Access-Control-Allow-Origin header is OMITTED, which causes
 *    the browser to block the response. We do NOT silently fall
 *    back to a "safe" origin like production, because that masks
 *    misconfigured callers and can let DNS-rebinding probes
 *    succeed against same-origin checks downstream.
 *  - `Vary: Origin` is set on every CORS response so caches
 *    do not mix responses across origins.
 *
 * ENV:
 *   ALLOWED_ORIGINS       — comma-separated allowlist (preferred). When set,
 *                           it fully replaces the built-in defaults below.
 *   ALLOWED_ORIGIN        — single origin (back-compat / preview envs).
 *   ENVIRONMENT           — when set to "production", forces the production
 *                           default allowlist if ALLOWED_ORIGINS is unset.
 *                           This is the recommended convention for explicit
 *                           env detection going forward.
 *   DENO_DEPLOYMENT_ID    — set by Supabase Edge Runtime / Deno Deploy in
 *                           production. Treated as a production signal for
 *                           back-compat with the existing convention.
 *
 * NOTE: Other helpers in this folder (e.g. Sentry init) gate on
 * DENO_DEPLOYMENT_ID. Going forward, callers should prefer
 * `ENVIRONMENT=production` for explicit production gating since it is
 * portable across runtimes (Deno Deploy, local Supabase CLI, CI).
 */

const PROD_DEFAULT_ORIGINS = [
  "https://motionmax.io",
  "https://app.motionmax.io",
  "https://www.motionmax.io",
];

const DEV_DEFAULT_ORIGINS = [
  "http://localhost:8080",
  "http://localhost:5173",
  "http://localhost:3000",
];

// Vercel preview pattern (kept from previous behaviour)
const VERCEL_PREVIEW_RE = /^https:\/\/motionmax-[a-z0-9-]+\.vercel\.app$/;

// Resolved at module scope, per the security spec: any per-request
// re-resolution would let a malicious request observe an env mutation.
const ALLOWED_ORIGINS_RAW = Deno.env.get("ALLOWED_ORIGINS");
const ALLOWED_ORIGIN_LEGACY = Deno.env.get("ALLOWED_ORIGIN");
const ENVIRONMENT_VAR = Deno.env.get("ENVIRONMENT");
const HAS_DEPLOYMENT_ID = Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));

function isProd(): boolean {
  // Prefer the explicit ENVIRONMENT var; fall back to Deno Deploy signal.
  if (ENVIRONMENT_VAR) return ENVIRONMENT_VAR === "production";
  return HAS_DEPLOYMENT_ID;
}

function resolveAllowedOrigins(): readonly string[] {
  if (ALLOWED_ORIGINS_RAW && ALLOWED_ORIGINS_RAW.trim().length > 0) {
    return ALLOWED_ORIGINS_RAW
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0 && o !== "*");
  }

  // Back-compat: legacy single-origin env var (kept for preview deployments).
  if (ALLOWED_ORIGIN_LEGACY && ALLOWED_ORIGIN_LEGACY.trim().length > 0 && ALLOWED_ORIGIN_LEGACY !== "*") {
    return [ALLOWED_ORIGIN_LEGACY.trim()];
  }

  return isProd() ? PROD_DEFAULT_ORIGINS : DEV_DEFAULT_ORIGINS;
}

const ALLOWED_ORIGINS: readonly string[] = resolveAllowedOrigins();

/**
 * Check if an origin is in the configured allow list.
 *
 * Exported for tests + callers that need to gate non-CORS behaviour
 * on origin trust (e.g. signed-asset proxies).
 */
export function isOriginAllowed(origin: string): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // Vercel preview deployments: convenience match for ephemeral previews.
  // Never matches "*". Production traffic still goes through the apex
  // domains in PROD_DEFAULT_ORIGINS, so this does not weaken prod CORS.
  if (VERCEL_PREVIEW_RE.test(origin)) return true;

  return false;
}

/**
 * Build secure CORS response headers.
 *
 * Behaviour:
 *  - Always sets `Vary: Origin`, `Access-Control-Allow-Headers`,
 *    `Access-Control-Allow-Methods`, and `Access-Control-Max-Age`.
 *  - Sets `Access-Control-Allow-Origin` ONLY when the request Origin
 *    is in the allowlist. Otherwise the header is omitted and the
 *    browser blocks the cross-origin read.
 */
export function getCorsHeaders(requestOrigin?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-connection-pooler, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  if (requestOrigin && isOriginAllowed(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
  }

  return headers;
}

/**
 * Handle an OPTIONS preflight request.
 *
 * Returns 204 with CORS headers when the origin is allowed,
 * 403 otherwise — preflight failure is the correct signal for a
 * disallowed cross-origin caller and avoids silently leaking
 * a "safe" origin back.
 */
export function handleCorsPreflightRequest(requestOrigin?: string | null): Response {
  const headers = getCorsHeaders(requestOrigin);
  const allowed = Boolean(headers["Access-Control-Allow-Origin"]);
  return new Response(null, {
    status: allowed ? 204 : 403,
    headers,
  });
}
