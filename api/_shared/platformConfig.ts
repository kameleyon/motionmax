/**
 * Centralised env-var lookups for OAuth platform config.
 *
 * Each helper returns either the resolved value or a structured "not
 * configured" Response (HTTP 503). Handlers can do:
 *
 *   const cfg = getYouTubeConfig();
 *   if ('error' in cfg) return cfg.error;
 *
 * That gives the UI a clear "platform not configured" state without
 * crashing the function.
 */

import { corsHeaders } from './cors';

type Configured<T> = T & { configured: true };
type NotConfigured = { configured: false; error: Response };

function notConfigured(platform: string, missing: string[], origin: string | null): NotConfigured {
  return {
    configured: false,
    error: new Response(
      JSON.stringify({
        error: `${platform}_oauth_not_configured`,
        message: `${platform} OAuth is not configured. Missing env vars: ${missing.join(', ')}`,
        missing,
      }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...corsHeaders(origin),
        },
      }
    ),
  };
}

export function getAppUrl(): string {
  return process.env.APP_URL ?? 'https://app.motionmax.io';
}

export type YouTubeConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export function getYouTubeConfig(origin: string | null): Configured<YouTubeConfig> | NotConfigured {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const missing: string[] = [];
  if (!clientId) missing.push('GOOGLE_OAUTH_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (missing.length) return notConfigured('YouTube', missing, origin);
  return {
    configured: true,
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: `${getAppUrl()}/api/autopost/connect/youtube/callback`,
  };
}

export type MetaConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
};

export function getMetaConfig(origin: string | null): Configured<MetaConfig> | NotConfigured {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const missing: string[] = [];
  if (!appId) missing.push('META_APP_ID');
  if (!appSecret) missing.push('META_APP_SECRET');
  if (missing.length) return notConfigured('Instagram', missing, origin);
  return {
    configured: true,
    appId: appId!,
    appSecret: appSecret!,
    redirectUri: `${getAppUrl()}/api/autopost/connect/instagram/callback`,
  };
}

export type TikTokConfig = {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
};

export function getTikTokConfig(origin: string | null): Configured<TikTokConfig> | NotConfigured {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const missing: string[] = [];
  if (!clientKey) missing.push('TIKTOK_CLIENT_KEY');
  if (!clientSecret) missing.push('TIKTOK_CLIENT_SECRET');
  if (missing.length) return notConfigured('TikTok', missing, origin);
  return {
    configured: true,
    clientKey: clientKey!,
    clientSecret: clientSecret!,
    redirectUri: `${getAppUrl()}/api/autopost/connect/tiktok/callback`,
  };
}

export function logError(at: string, err: unknown, extra: Record<string, unknown> = {}): void {
  const e = err as { message?: string; stack?: string } | undefined;
  console.error(
    JSON.stringify({
      at,
      err: e?.message ?? String(err),
      stack: e?.stack,
      ...extra,
    })
  );
}

/**
 * Build a redirect to the lab connect page with status query params.
 */
export function connectRedirect(params: {
  platform: 'youtube' | 'instagram' | 'tiktok';
  status: 'connected' | 'error';
  reason?: string;
}): Response {
  const url = new URL('/lab/autopost/connect', getAppUrl());
  url.searchParams.set('platform', params.platform);
  url.searchParams.set('status', params.status);
  if (params.reason) url.searchParams.set('reason', params.reason);
  return Response.redirect(url.toString(), 302);
}
