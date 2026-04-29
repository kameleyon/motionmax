/**
 * GET /api/autopost/accounts
 *
 * Lists the caller's connected social accounts. Strips access_token /
 * refresh_token from the response — the browser never needs them.
 *
 * Auth: admin session JWT (Authorization: Bearer required; we discourage
 * the ?token query for non-OAuth-start endpoints).
 */

import { requireAdmin, isResponse } from '../../_shared/auth';
import { handlePreflight, corsHeaders } from '../../_shared/cors';
import { logError } from '../../_shared/platformConfig';
import { webHandler } from '../../_shared/webHandler';

type SocialAccountRow = {
  id: string;
  user_id: string;
  platform: 'youtube' | 'instagram' | 'tiktok';
  platform_account_id: string;
  display_name: string;
  avatar_url: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at: string | null;
  scopes: string[];
  status: 'connected' | 'expired' | 'revoked' | 'error';
  last_error: string | null;
  provider_metadata: unknown;
  connected_at: string;
};

export default webHandler(async (req: Request): Promise<Response> => {
  const pf = handlePreflight(req);
  if (pf) return pf;

  const origin = req.headers.get('origin');

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  let user, supabase;
  try {
    ({ user, supabase } = await requireAdmin(req));
  } catch (e) {
    if (isResponse(e)) return e;
    logError('autopost.accounts.list.auth', e);
    return new Response(JSON.stringify({ error: 'auth_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  try {
    const { data, error } = await supabase
      .from('autopost_social_accounts')
      .select(
        'id, user_id, platform, platform_account_id, display_name, avatar_url, ' +
          'token_expires_at, scopes, status, last_error, provider_metadata, connected_at'
      )
      .eq('user_id', user.id)
      .order('connected_at', { ascending: false });

    if (error) {
      logError('autopost.accounts.list.query', error);
      return new Response(
        JSON.stringify({ error: 'db_query_failed', message: error.message }),
        {
          status: 500,
          headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
        }
      );
    }

    // Defensive scrub: select() above already excludes tokens, but if a future
    // refactor changes it we still strip here.
    const sanitized = (data ?? []).map((a) => {
      const row = a as unknown as SocialAccountRow;
      const { access_token: _at, refresh_token: _rt, ...rest } = row;
      void _at;
      void _rt;
      return rest;
    });

    return new Response(JSON.stringify({ accounts: sanitized }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...corsHeaders(origin),
      },
    });
  } catch (e) {
    logError('autopost.accounts.list', e);
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }
});
