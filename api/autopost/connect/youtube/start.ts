/**
 * GET /api/autopost/connect/youtube/start
 *
 * Browser-driven entry point for the YouTube OAuth flow.
 *
 * Auth: requires admin session JWT, supplied via Authorization: Bearer
 * header OR ?token=<jwt> query (the React app uses the latter because it
 * can't set custom headers on a top-level navigation).
 *
 * On success: 302 redirect to Google's OAuth consent screen with a signed
 * state token pinning the flow to this user.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const TTL_MS = 10 * 60 * 1000;

function b64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf-8') : Buffer.from(input);
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signState(userId: string): Promise<string> {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('OAUTH_STATE_SECRET env var must be set and at least 32 characters');
  }
  const nonceBytes = new Uint8Array(16);
  (globalThis.crypto || (await import('node:crypto')).webcrypto).getRandomValues(nonceBytes);
  const payload = {
    userId,
    platform: 'youtube' as const,
    nonce: b64UrlEncode(nonceBytes),
    exp: Date.now() + TTL_MS,
  };
  const payloadB64 = b64UrlEncode(JSON.stringify(payload));
  const subtle = (globalThis.crypto || (await import('node:crypto')).webcrypto).subtle;
  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${b64UrlEncode(new Uint8Array(sigBuf))}`;
}

function extractJwt(req: IncomingMessage): string | null {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string') {
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  // ?token=<jwt> fallback used by browser GET nav
  const url = req.url || '';
  const qIdx = url.indexOf('?');
  if (qIdx >= 0) {
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const t = params.get('token');
    if (t) return t.trim();
  }
  return null;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'GET') {
      return jsonResponse(res, 405, { error: 'method_not_allowed' });
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const appUrl = process.env.APP_URL || 'https://www.motionmax.io';

    const missing: string[] = [];
    if (!clientId) missing.push('GOOGLE_OAUTH_CLIENT_ID');
    if (!clientSecret) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!supabaseUrl) missing.push('SUPABASE_URL');
    if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (missing.length) {
      return jsonResponse(res, 503, { error: 'env_missing', missing });
    }

    const jwt = extractJwt(req);
    if (!jwt) {
      return jsonResponse(res, 401, { error: 'missing_authorization' });
    }

    const supabase = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return jsonResponse(res, 401, { error: 'invalid_token', message: userErr?.message });
    }
    const userId = userData.user.id;

    const { data: isAdmin, error: rpcErr } = await supabase.rpc('is_admin', { _user_id: userId });
    if (rpcErr) {
      return jsonResponse(res, 500, { error: 'is_admin_rpc_failed', message: rpcErr.message });
    }
    if (isAdmin !== true) {
      return jsonResponse(res, 403, { error: 'forbidden' });
    }

    const state = await signState(userId);
    const redirectUri = `${appUrl}/api/autopost/connect/youtube/callback`;

    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.searchParams.set('client_id', clientId!);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', SCOPES.join(' '));
    auth.searchParams.set('access_type', 'offline');
    auth.searchParams.set('prompt', 'consent');
    auth.searchParams.set('include_granted_scopes', 'true');
    auth.searchParams.set('state', state);

    res.statusCode = 302;
    res.setHeader('Location', auth.toString());
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ at: 'youtube.start.uncaught', err: message }));
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: 'internal_error', message });
    } else {
      res.end();
    }
  }
}
