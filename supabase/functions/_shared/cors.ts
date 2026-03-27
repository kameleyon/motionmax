/**
 * Secure CORS configuration for Supabase Edge Functions
 *
 * SECURITY: Never uses wildcard (*) in production
 * Explicitly validates origins against allowed list
 */

const PRODUCTION_ORIGIN = "https://motionmax.io";
const ALLOWED_ORIGINS = [
  PRODUCTION_ORIGIN,
  "https://www.motionmax.io",
  "http://localhost:5173",
  "http://localhost:8080",
  // Add any Vercel preview domains here
  // "https://motionmax-preview-*.vercel.app"
];

/**
 * Get secure CORS headers that never default to wildcard
 */
export function getCorsHeaders(requestOrigin?: string | null): Record<string, string> {
  // Get configured origin from environment (for preview deployments)
  const configuredOrigin = Deno.env.get("ALLOWED_ORIGIN");

  let allowedOrigin: string;

  if (configuredOrigin && configuredOrigin !== "*") {
    // Use explicitly configured origin (for preview environments)
    allowedOrigin = configuredOrigin;
  } else if (requestOrigin && isOriginAllowed(requestOrigin)) {
    // Validate and use request origin if it's in our allow list
    allowedOrigin = requestOrigin;
  } else {
    // Default to production origin (never wildcard)
    allowedOrigin = PRODUCTION_ORIGIN;
  }

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-connection-pooler, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * Check if an origin is in the allow list
 */
function isOriginAllowed(origin: string): boolean {
  // Exact match
  if (ALLOWED_ORIGINS.includes(origin)) {
    return true;
  }

  // Pattern match for preview deployments (e.g., Vercel)
  // This is safer than wildcard but still needs to be carefully managed
  const isVercelPreview = /^https:\/\/motionmax-[a-z0-9-]+\.vercel\.app$/.test(origin);
  if (isVercelPreview) {
    return true;
  }

  return false;
}

/**
 * Handle OPTIONS preflight request
 */
export function handleCorsPreflightRequest(requestOrigin?: string | null): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(requestOrigin),
  });
}
