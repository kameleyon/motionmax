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

import { requireAdmin, isResponse } from '../../../_shared/auth';
import { handlePreflight, corsHeaders } from '../../../_shared/cors';
import { signState } from '../../../_shared/oauthState';
import { getYouTubeConfig, logError } from '../../../_shared/platformConfig';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

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

  const cfg = getYouTubeConfig(origin);
  if (!cfg.configured) return cfg.error;

  let user;
  try {
    ({ user } = await requireAdmin(req));
  } catch (e) {
    if (isResponse(e)) return e;
    logError('autopost.oauth.youtube.start.auth', e);
    return new Response(JSON.stringify({ error: 'auth_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  let state: string;
  try {
    state = await signState({ userId: user.id, platform: 'youtube' });
  } catch (e) {
    logError('autopost.oauth.youtube.start.state', e);
    return new Response(
      JSON.stringify({ error: 'state_signing_failed', message: (e as Error).message }),
      {
        status: 500,
        headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
      }
    );
  }

  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', cfg.clientId);
  auth.searchParams.set('redirect_uri', cfg.redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', SCOPES.join(' '));
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('include_granted_scopes', 'true');
  auth.searchParams.set('state', state);

  return Response.redirect(auth.toString(), 302);
}
