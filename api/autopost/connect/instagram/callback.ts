/**
 * GET /api/autopost/connect/instagram/callback?code=...&state=...
 *
 * Meta redirects here after consent. Flow:
 *   1. Verify signed state.
 *   2. Exchange code for short-lived user access token.
 *   3. Call /me/accounts to enumerate Pages the user manages.
 *   4. For each page, fetch /{page-id}?fields=instagram_business_account,access_token
 *      and find the first one with an attached IG Business account.
 *   5. Store the PAGE access_token (long-lived, ~60d) — we DO NOT store
 *      the user token. Page tokens are what the publish handler actually
 *      uses against the Graph API for media containers.
 *   6. platform_account_id = ig_business_account.id.
 *
 * Edge cases:
 *   - Zero IG Business accounts found → redirect with reason=no_ig_business
 *   - We pick the FIRST one. Multi-account users connect again with the
 *     specific page selected via Meta's account switcher.
 */

import { handlePreflight } from '../../../_shared/cors';
import { verifyState } from '../../../_shared/oauthState';
import { createAdminClient } from '../../../_shared/supabaseAdmin';
import {
  connectRedirect,
  getMetaConfig,
  logError,
} from '../../../_shared/platformConfig';

type MetaTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
};

type MetaAccountsPage = {
  id: string;
  name?: string;
  access_token?: string;
};

type MetaAccountsResponse = {
  data?: MetaAccountsPage[];
};

type MetaPageDetail = {
  id: string;
  access_token?: string;
  instagram_business_account?: {
    id: string;
    username?: string;
    name?: string;
    profile_picture_url?: string;
  };
};

export default async function handler(req: Request): Promise<Response> {
  const pf = handlePreflight(req);
  if (pf) return pf;

  if (req.method !== 'GET') {
    return connectRedirect({ platform: 'instagram', status: 'error', reason: 'method' });
  }

  const origin = req.headers.get('origin');
  const cfg = getMetaConfig(origin);
  if (!cfg.configured) return cfg.error;

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return connectRedirect({ platform: 'instagram', status: 'error', reason: oauthError });
  }
  if (!code || !stateParam) {
    return connectRedirect({ platform: 'instagram', status: 'error', reason: 'missing_params' });
  }

  const stateResult = await verifyState(stateParam);
  if (!stateResult.ok) {
    logError('autopost.oauth.instagram.callback.state', new Error(stateResult.reason));
    return connectRedirect({ platform: 'instagram', status: 'error', reason: stateResult.reason });
  }
  if (stateResult.payload.platform !== 'instagram') {
    return connectRedirect({ platform: 'instagram', status: 'error', reason: 'platform_mismatch' });
  }
  const userId = stateResult.payload.userId;

  // ---- exchange code for user token ----
  let userToken: MetaTokenResponse;
  try {
    const tokenUrl = new URL('https://graph.facebook.com/v19.0/oauth/access_token');
    tokenUrl.searchParams.set('client_id', cfg.appId);
    tokenUrl.searchParams.set('client_secret', cfg.appSecret);
    tokenUrl.searchParams.set('redirect_uri', cfg.redirectUri);
    tokenUrl.searchParams.set('code', code);
    const r = await fetch(tokenUrl.toString(), { method: 'GET' });
    if (!r.ok) {
      const text = await r.text();
      logError(
        'autopost.oauth.instagram.callback.token',
        new Error(`token exchange ${r.status}: ${text}`)
      );
      return connectRedirect({ platform: 'instagram', status: 'error', reason: 'token_exchange_failed' });
    }
    userToken = (await r.json()) as MetaTokenResponse;
  } catch (e) {
    logError('autopost.oauth.instagram.callback.token', e);
    return connectRedirect({ platform: 'instagram', status: 'error', reason: 'token_exchange_failed' });
  }

  // ---- list pages ----
  let pages: MetaAccountsPage[];
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${encodeURIComponent(userToken.access_token)}&fields=id,name,access_token`
    );
    if (!r.ok) {
      const text = await r.text();
      logError(
        'autopost.oauth.instagram.callback.accounts',
        new Error(`me/accounts ${r.status}: ${text}`)
      );
      return connectRedirect({ platform: 'instagram', status: 'error', reason: 'pages_lookup_failed' });
    }
    const data = (await r.json()) as MetaAccountsResponse;
    pages = data.data ?? [];
    if (pages.length === 0) {
      return connectRedirect({ platform: 'instagram', status: 'error', reason: 'no_pages' });
    }
  } catch (e) {
    logError('autopost.oauth.instagram.callback.accounts', e);
    return connectRedirect({ platform: 'instagram', status: 'error', reason: 'pages_lookup_failed' });
  }

  // ---- find first page with IG Business account ----
  let chosenPage: MetaPageDetail | undefined;
  for (const page of pages) {
    try {
      const r = await fetch(
        `https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account{id,username,name,profile_picture_url},access_token&access_token=${encodeURIComponent(userToken.access_token)}`
      );
      if (!r.ok) {
        const text = await r.text();
        logError(
          'autopost.oauth.instagram.callback.page_detail',
          new Error(`page ${page.id} ${r.status}: ${text}`)
        );
        continue;
      }
      const detail = (await r.json()) as MetaPageDetail;
      if (detail.instagram_business_account?.id) {
        chosenPage = detail;
        break;
      }
    } catch (e) {
      logError('autopost.oauth.instagram.callback.page_detail', e, { pageId: page.id });
    }
  }

  if (!chosenPage || !chosenPage.instagram_business_account) {
    return connectRedirect({ platform: 'instagram', status: 'error', reason: 'no_ig_business' });
  }

  const ig = chosenPage.instagram_business_account!;
  const pageToken = chosenPage.access_token ?? userToken.access_token;
  const expiresAt =
    typeof userToken.expires_in === 'number'
      ? new Date(Date.now() + userToken.expires_in * 1000).toISOString()
      : null;

  try {
    const supabase = createAdminClient();
    const { error } = await supabase
      .from('autopost_social_accounts')
      .upsert(
        {
          user_id: userId,
          platform: 'instagram',
          platform_account_id: ig.id,
          display_name: ig.username ?? ig.name ?? `Instagram ${ig.id}`,
          avatar_url: ig.profile_picture_url ?? null,
          access_token: pageToken,
          refresh_token: null,
          token_expires_at: expiresAt,
          scopes: [
            'instagram_business_basic',
            'instagram_business_content_publish',
            'pages_show_list',
            'business_management',
          ],
          status: 'connected',
          last_error: null,
          provider_metadata: {
            page_id: chosenPage.id,
          },
          connected_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,platform,platform_account_id' }
      );
    if (error) {
      logError('autopost.oauth.instagram.callback.upsert', error);
      return connectRedirect({ platform: 'instagram', status: 'error', reason: 'db_upsert_failed' });
    }
  } catch (e) {
    logError('autopost.oauth.instagram.callback.upsert', e);
    return connectRedirect({ platform: 'instagram', status: 'error', reason: 'db_upsert_failed' });
  }

  return connectRedirect({ platform: 'instagram', status: 'connected' });
}
