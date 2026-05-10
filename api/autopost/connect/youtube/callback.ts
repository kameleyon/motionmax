/**
 * GET /api/autopost/connect/youtube/callback?code=...&state=...
 *
 * Google redirects the user here after consent. We:
 *   1. Verify the signed state token (defends against CSRF).
 *   2. Exchange the code for tokens at oauth2.googleapis.com/token.
 *   3. Look up the connected channel via YouTube Data API v3.
 *   4. Upsert into autopost_social_accounts.
 *   5. Redirect back to /lab/autopost/connect?platform=youtube&status=connected.
 */

import { handlePreflight } from '../../../_shared/cors';
import { encryptSecret } from '../../../_shared/encryption';
import { verifyState } from '../../../_shared/oauthState';
import { createAdminClient } from '../../../_shared/supabaseAdmin';
import {
  connectRedirect,
  getYouTubeConfig,
  logError,
} from '../../../_shared/platformConfig';
import { webHandler } from '../../../_shared/webHandler';

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: 'Bearer';
};

type YouTubeChannel = {
  id: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
  };
};

type YouTubeChannelListResponse = {
  items?: YouTubeChannel[];
};

export default webHandler(async (req: Request): Promise<Response> => {
  const pf = handlePreflight(req);
  if (pf) return pf;

  if (req.method !== 'GET') {
    return connectRedirect({ platform: 'youtube', status: 'error', reason: 'method' });
  }

  const origin = req.headers.get('origin');
  const cfg = getYouTubeConfig(origin);
  if (!cfg.configured) return cfg.error;

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return connectRedirect({ platform: 'youtube', status: 'error', reason: oauthError });
  }
  if (!code || !stateParam) {
    return connectRedirect({ platform: 'youtube', status: 'error', reason: 'missing_params' });
  }

  const stateResult = await verifyState(stateParam);
  if (!stateResult.ok) {
    logError('autopost.oauth.youtube.callback.state', new Error(stateResult.reason));
    return connectRedirect({ platform: 'youtube', status: 'error', reason: stateResult.reason });
  }
  if (stateResult.payload.platform !== 'youtube') {
    return connectRedirect({ platform: 'youtube', status: 'error', reason: 'platform_mismatch' });
  }
  const userId = stateResult.payload.userId;

  // ---- token exchange ----
  let tokens: GoogleTokenResponse;
  try {
    const body = new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!r.ok) {
      const text = await r.text();
      logError('autopost.oauth.youtube.callback.token', new Error(`token exchange ${r.status}: ${text}`));
      return connectRedirect({ platform: 'youtube', status: 'error', reason: 'token_exchange_failed' });
    }
    tokens = (await r.json()) as GoogleTokenResponse;
  } catch (e) {
    logError('autopost.oauth.youtube.callback.token', e);
    return connectRedirect({ platform: 'youtube', status: 'error', reason: 'token_exchange_failed' });
  }

  // ---- channel lookup ----
  let channel: YouTubeChannel | undefined;
  try {
    const r = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,id&mine=true',
      { headers: { authorization: `Bearer ${tokens.access_token}` } }
    );
    if (!r.ok) {
      const text = await r.text();
      logError('autopost.oauth.youtube.callback.channels', new Error(`channels.list ${r.status}: ${text}`));
      return connectRedirect({ platform: 'youtube', status: 'error', reason: 'channel_lookup_failed' });
    }
    const data = (await r.json()) as YouTubeChannelListResponse;
    channel = data.items?.[0];
    if (!channel?.id) {
      return connectRedirect({ platform: 'youtube', status: 'error', reason: 'no_channel' });
    }
  } catch (e) {
    logError('autopost.oauth.youtube.callback.channels', e);
    return connectRedirect({ platform: 'youtube', status: 'error', reason: 'channel_lookup_failed' });
  }

  // ---- upsert ----
  const expiresAt =
    typeof tokens.expires_in === 'number'
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;
  const scopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [];
  const displayName =
    channel.snippet?.title ?? channel.snippet?.customUrl ?? `YouTube ${channel.id}`;
  const avatarUrl =
    channel.snippet?.thumbnails?.medium?.url ?? channel.snippet?.thumbnails?.default?.url ?? null;

  // Encrypt OAuth tokens before persisting. The DB-level CHECK constraint
  // added by 20260510130000_encrypt_oauth_and_api_keys.sql rejects any
  // INSERT/UPDATE whose access_token/refresh_token isn't in the v1: or
  // v3: ciphertext format, so a missed call here would surface as a
  // db_upsert_failed redirect rather than silently leaking plaintext.
  let encryptedAccessToken: string;
  let encryptedRefreshToken: string | null = null;
  try {
    encryptedAccessToken = await encryptSecret(tokens.access_token);
    if (tokens.refresh_token) {
      encryptedRefreshToken = await encryptSecret(tokens.refresh_token);
    }
  } catch (e) {
    logError('autopost.oauth.youtube.callback.encrypt', e);
    return connectRedirect({ platform: 'youtube', status: 'error', reason: 'token_encrypt_failed' });
  }

  try {
    const supabase = createAdminClient();
    const { error } = await supabase
      .from('autopost_social_accounts')
      .upsert(
        {
          user_id: userId,
          platform: 'youtube',
          platform_account_id: channel.id,
          display_name: displayName,
          avatar_url: avatarUrl,
          access_token: encryptedAccessToken,
          refresh_token: encryptedRefreshToken,
          token_expires_at: expiresAt,
          scopes,
          status: 'connected',
          last_error: null,
          provider_metadata: {
            custom_url: channel.snippet?.customUrl ?? null,
          },
          connected_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,platform,platform_account_id' }
      );
    if (error) {
      logError('autopost.oauth.youtube.callback.upsert', error);
      return connectRedirect({ platform: 'youtube', status: 'error', reason: 'db_upsert_failed' });
    }
  } catch (e) {
    logError('autopost.oauth.youtube.callback.upsert', e);
    return connectRedirect({ platform: 'youtube', status: 'error', reason: 'db_upsert_failed' });
  }

  return connectRedirect({ platform: 'youtube', status: 'connected' });
});
