/**
 * Admin auth guard for Vercel Functions.
 *
 * Validates the caller's Supabase session JWT (Authorization: Bearer <jwt>
 * or ?token=<jwt> for browser GETs to OAuth-start endpoints) and confirms
 * they are a MotionMax admin via the `is_admin(uuid)` RPC.
 *
 * Usage:
 *   const { user, supabase } = await requireAdmin(req);
 *
 * On failure throws a Response (401/403) the handler should return verbatim.
 */

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createAdminClient } from './supabaseAdmin';
import { corsHeaders } from './cors';

export type AdminAuthOk = {
  user: User;
  supabase: SupabaseClient;
  jwt: string;
};

function jsonError(status: number, body: object, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
    },
  });
}

/**
 * Pulls a JWT from `Authorization: Bearer <jwt>` first, falling back to
 * `?token=<jwt>` (only used by browser-driven OAuth-start GETs that can't
 * set a custom header before navigating cross-origin).
 */
function extractJwt(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  try {
    const url = new URL(req.url);
    const t = url.searchParams.get('token');
    if (t) return t.trim();
  } catch {
    /* unparseable url — falls through */
  }
  return null;
}

export async function requireAdmin(req: Request): Promise<AdminAuthOk> {
  const origin = req.headers.get('origin');
  const supabase = createAdminClient();
  const jwt = extractJwt(req);

  if (!jwt) {
    throw jsonError(401, { error: 'missing_authorization', message: 'Missing bearer token' }, origin);
  }

  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    throw jsonError(
      401,
      { error: 'invalid_token', message: userErr?.message ?? 'Invalid session token' },
      origin
    );
  }
  const user = userData.user;

  const { data: isAdmin, error: rpcErr } = await supabase.rpc('is_admin', { _user_id: user.id });
  if (rpcErr) {
    throw jsonError(
      500,
      { error: 'is_admin_rpc_failed', message: rpcErr.message },
      origin
    );
  }
  if (isAdmin !== true) {
    throw jsonError(403, { error: 'forbidden', message: 'Admin access required' }, origin);
  }

  return { user, supabase, jwt };
}

/**
 * Helper for handlers that catch the Response thrown by requireAdmin and want
 * to log unexpected non-Response errors.
 */
export function isResponse(err: unknown): err is Response {
  return typeof Response !== 'undefined' && err instanceof Response;
}
