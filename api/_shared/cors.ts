/**
 * CORS helper for autopost Vercel Functions.
 *
 * Allowlist:
 *   - https://app.motionmax.io  (production app)
 *   - https://motionmax.io      (apex / marketing)
 *   - http://localhost:* / http://127.0.0.1:*  (dev only — see ALLOW_LOCALHOST)
 *
 * Returns headers as a plain Record<string, string> so callers can spread them
 * into a `new Response()` or hand them to the existing Headers API.
 */

const STATIC_ALLOWED = new Set<string>([
  'https://app.motionmax.io',
  'https://motionmax.io',
]);

// Only allow localhost in non-production. Vercel sets VERCEL_ENV to
// 'production' | 'preview' | 'development' for serverless functions.
function localhostAllowed(): boolean {
  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
  return env !== 'production';
}

export function isOriginAllowed(origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (STATIC_ALLOWED.has(origin)) return true;
  if (!localhostAllowed()) return false;

  try {
    const u = new URL(origin);
    return (
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      (u.protocol === 'http:' || u.protocol === 'https:')
    );
  } catch {
    return false;
  }
}

export function corsHeaders(origin: string | null | undefined): Record<string, string> {
  const allowed = isOriginAllowed(origin) ? origin! : '';
  const headers: Record<string, string> = {
    Vary: 'Origin',
  };
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = allowed;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, PATCH, OPTIONS';
    headers['Access-Control-Allow-Headers'] =
      'authorization, x-client-info, apikey, content-type';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

/**
 * Short-circuits OPTIONS preflights with the right headers.
 * Returns null for non-OPTIONS so the handler can continue.
 */
export function handlePreflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  const origin = req.headers.get('origin');
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}
