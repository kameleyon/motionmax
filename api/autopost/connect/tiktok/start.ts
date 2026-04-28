/**
 * GET /api/autopost/connect/tiktok/start
 *
 * Browser-driven entry point for the TikTok OAuth flow (Login Kit v2).
 *
 * Auth: admin session JWT via Authorization: Bearer or ?token=<jwt>.
 *
 * Scopes:
 *   - user.info.basic   (display_name, avatar_url)
 *   - video.upload      (upload + draft)
 *   - video.publish     (Direct Post API — gated until audit clears)
 */

import { requireAdmin, isResponse } from '../../../_shared/auth';
import { handlePreflight, corsHeaders } from '../../../_shared/cors';
import { signState } from '../../../_shared/oauthState';
import { getTikTokConfig, logError } from '../../../_shared/platformConfig';

const SCOPES = ['user.info.basic', 'video.upload', 'video.publish'];

export default async function handler(req: Request): Promise<Response> {
  const pf = handlePreflight(req);
  if (pf) return pf;

  const origin = req.headers.get('origin');

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const cfg = getTikTokConfig(origin);
  if (!cfg.configured) return cfg.error;

  let user;
  try {
    ({ user } = await requireAdmin(req));
  } catch (e) {
    if (isResponse(e)) return e;
    logError('autopost.oauth.tiktok.start.auth', e);
    return new Response(JSON.stringify({ error: 'auth_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  let state: string;
  try {
    state = await signState({ userId: user.id, platform: 'tiktok' });
  } catch (e) {
    logError('autopost.oauth.tiktok.start.state', e);
    return new Response(
      JSON.stringify({ error: 'state_signing_failed', message: (e as Error).message }),
      {
        status: 500,
        headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
      }
    );
  }

  // TikTok requires a trailing slash on /v2/auth/authorize/.
  const auth = new URL('https://www.tiktok.com/v2/auth/authorize/');
  auth.searchParams.set('client_key', cfg.clientKey);
  auth.searchParams.set('redirect_uri', cfg.redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', SCOPES.join(','));
  auth.searchParams.set('state', state);

  return Response.redirect(auth.toString(), 302);
}
