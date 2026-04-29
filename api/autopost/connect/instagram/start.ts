/**
 * GET /api/autopost/connect/instagram/start
 *
 * Browser-driven entry point for the Instagram (Meta Graph) OAuth flow.
 *
 * Auth: admin session JWT via Authorization: Bearer or ?token=<jwt>.
 *
 * Scopes requested cover the Instagram Business publishing path:
 *   - instagram_business_basic           (read business account metadata)
 *   - instagram_business_content_publish (Reels publishing)
 *   - pages_show_list                    (list FB pages owned by user)
 *   - business_management                (operate page assets on user's behalf)
 */

import { requireAdmin, isResponse } from '../../../_shared/auth';
import { handlePreflight, corsHeaders } from '../../../_shared/cors';
import { signState } from '../../../_shared/oauthState';
import { getMetaConfig, logError } from '../../../_shared/platformConfig';
import { webHandler } from '../../../_shared/webHandler';

const SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'pages_show_list',
  'business_management',
];

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

  const cfg = getMetaConfig(origin);
  if (!cfg.configured) return cfg.error;

  let user;
  try {
    ({ user } = await requireAdmin(req));
  } catch (e) {
    if (isResponse(e)) return e;
    logError('autopost.oauth.instagram.start.auth', e);
    return new Response(JSON.stringify({ error: 'auth_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  let state: string;
  try {
    state = await signState({ userId: user.id, platform: 'instagram' });
  } catch (e) {
    logError('autopost.oauth.instagram.start.state', e);
    return new Response(
      JSON.stringify({ error: 'state_signing_failed', message: (e as Error).message }),
      {
        status: 500,
        headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
      }
    );
  }

  const auth = new URL('https://www.facebook.com/v19.0/dialog/oauth');
  auth.searchParams.set('client_id', cfg.appId);
  auth.searchParams.set('redirect_uri', cfg.redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', SCOPES.join(','));
  auth.searchParams.set('state', state);

  return Response.redirect(auth.toString(), 302);
});
