/**
 * GET /api/autopost/connect/tiktok/callback?code=...&state=...
 *
 * Flow:
 *   1. Verify signed state.
 *   2. POST to /v2/oauth/token/ to exchange code -> access_token + refresh_token + open_id.
 *   3. GET /v2/user/info/?fields=open_id,avatar_url,display_name to get the profile.
 *   4. Upsert into autopost_social_accounts with platform_account_id = open_id.
 */

import { handlePreflight } from '../../../_shared/cors';
import { verifyState } from '../../../_shared/oauthState';
import { createAdminClient } from '../../../_shared/supabaseAdmin';
import {
  connectRedirect,
  getTikTokConfig,
  logError,
} from '../../../_shared/platformConfig';
import { webHandler } from '../../../_shared/webHandler';

type TikTokTokenResponse = {
  access_token: string;
  expires_in: number;
  open_id: string;
  refresh_expires_in?: number;
  refresh_token: string;
  scope: string;
  token_type: string;
  // Older shape:
  error?: string;
  error_description?: string;
};

type TikTokUserInfo = {
  data?: {
    user?: {
      open_id?: string;
      union_id?: string;
      avatar_url?: string;
      display_name?: string;
    };
  };
  error?: {
    code?: string;
    message?: string;
  };
};

export default webHandler(async (req: Request): Promise<Response> => {
  const pf = handlePreflight(req);
  if (pf) return pf;

  if (req.method !== 'GET') {
    return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'method' });
  }

  const origin = req.headers.get('origin');
  const cfg = getTikTokConfig(origin);
  if (!cfg.configured) return cfg.error;

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return connectRedirect({ platform: 'tiktok', status: 'error', reason: oauthError });
  }
  if (!code || !stateParam) {
    return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'missing_params' });
  }

  const stateResult = await verifyState(stateParam);
  if (!stateResult.ok) {
    logError('autopost.oauth.tiktok.callback.state', new Error(stateResult.reason));
    return connectRedirect({ platform: 'tiktok', status: 'error', reason: stateResult.reason });
  }
  if (stateResult.payload.platform !== 'tiktok') {
    return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'platform_mismatch' });
  }
  const userId = stateResult.payload.userId;

  // ---- token exchange ----
  let tokens: TikTokTokenResponse;
  try {
    const body = new URLSearchParams({
      client_key: cfg.clientKey,
      client_secret: cfg.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: cfg.redirectUri,
    });
    const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cache-control': 'no-cache',
      },
      body: body.toString(),
    });
    const text = await r.text();
    if (!r.ok) {
      logError(
        'autopost.oauth.tiktok.callback.token',
        new Error(`token exchange ${r.status}: ${text}`)
      );
      return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'token_exchange_failed' });
    }
    tokens = JSON.parse(text) as TikTokTokenResponse;
    if (tokens.error || !tokens.access_token) {
      logError(
        'autopost.oauth.tiktok.callback.token',
        new Error(`token error: ${tokens.error_description ?? tokens.error ?? 'no access_token'}`)
      );
      return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'token_exchange_failed' });
    }
  } catch (e) {
    logError('autopost.oauth.tiktok.callback.token', e);
    return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'token_exchange_failed' });
  }

  // ---- user info ----
  let info: TikTokUserInfo;
  try {
    const r = await fetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name',
      { headers: { authorization: `Bearer ${tokens.access_token}` } }
    );
    const text = await r.text();
    if (!r.ok) {
      logError(
        'autopost.oauth.tiktok.callback.userinfo',
        new Error(`user/info ${r.status}: ${text}`)
      );
      return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'user_info_failed' });
    }
    info = JSON.parse(text) as TikTokUserInfo;
    if (info.error?.code && info.error.code !== 'ok') {
      logError('autopost.oauth.tiktok.callback.userinfo', new Error(info.error.message ?? 'user info error'));
      return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'user_info_failed' });
    }
  } catch (e) {
    logError('autopost.oauth.tiktok.callback.userinfo', e);
    return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'user_info_failed' });
  }

  const openId = info.data?.user?.open_id ?? tokens.open_id;
  if (!openId) {
    return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'no_open_id' });
  }
  const displayName = info.data?.user?.display_name ?? `TikTok ${openId.slice(0, 6)}`;
  const avatarUrl = info.data?.user?.avatar_url ?? null;
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const scopes = tokens.scope ? tokens.scope.split(/[,\s]+/).filter(Boolean) : [];

  try {
    const supabase = createAdminClient();
    const { error } = await supabase
      .from('autopost_social_accounts')
      .upsert(
        {
          user_id: userId,
          platform: 'tiktok',
          platform_account_id: openId,
          display_name: displayName,
          avatar_url: avatarUrl,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? null,
          token_expires_at: expiresAt,
          scopes,
          status: 'connected',
          last_error: null,
          provider_metadata: {
            union_id: info.data?.user?.union_id ?? null,
          },
          connected_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,platform,platform_account_id' }
      );
    if (error) {
      logError('autopost.oauth.tiktok.callback.upsert', error);
      return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'db_upsert_failed' });
    }
  } catch (e) {
    logError('autopost.oauth.tiktok.callback.upsert', e);
    return connectRedirect({ platform: 'tiktok', status: 'error', reason: 'db_upsert_failed' });
  }

  return connectRedirect({ platform: 'tiktok', status: 'connected' });
});
