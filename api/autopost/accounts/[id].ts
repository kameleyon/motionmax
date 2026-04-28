/**
 * DELETE /api/autopost/accounts/:id
 *
 * Disconnects (revokes + deletes) one connected social account.
 *
 * Auth: admin session JWT.
 *
 * Best-effort revocation at the provider:
 *   - youtube  -> POST https://oauth2.googleapis.com/revoke?token=<access_token>
 *   - instagram -> DELETE https://graph.facebook.com/v19.0/{ig_user_id}/permissions
 *   - tiktok    -> POST https://open.tiktokapis.com/v2/oauth/revoke/
 *
 * If the provider revoke fails (token already expired, network blip,
 * etc.), we still delete the DB row and return 200 — at that point the
 * account is unusable anyway and leaving it in our DB just confuses the
 * UI.
 */

import { requireAdmin, isResponse } from '../../_shared/auth';
import { handlePreflight, corsHeaders } from '../../_shared/cors';
import { logError } from '../../_shared/platformConfig';

type DbAccount = {
  id: string;
  user_id: string;
  platform: 'youtube' | 'instagram' | 'tiktok';
  platform_account_id: string;
  access_token: string | null;
};

function extractIdFromUrl(req: Request): string | null {
  try {
    const u = new URL(req.url);
    // Vercel rewrites the file path so the segment after /accounts/ is the id.
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.lastIndexOf('accounts');
    if (i >= 0 && parts.length > i + 1) {
      return decodeURIComponent(parts[i + 1]!);
    }
    // Fallback: ?id=
    const q = u.searchParams.get('id');
    return q ? q.trim() : null;
  } catch {
    return null;
  }
}

async function revokeYouTube(token: string): Promise<void> {
  const r = await fetch(
    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }
  );
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`youtube revoke ${r.status}: ${body}`);
  }
}

async function revokeInstagram(igUserId: string, token: string): Promise<void> {
  const r = await fetch(
    `https://graph.facebook.com/v19.0/${encodeURIComponent(igUserId)}/permissions?access_token=${encodeURIComponent(token)}`,
    { method: 'DELETE' }
  );
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`meta revoke ${r.status}: ${body}`);
  }
}

async function revokeTikTok(token: string): Promise<void> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    throw new Error('tiktok revoke skipped: missing TIKTOK_CLIENT_KEY/SECRET');
  }
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    token,
  });
  const r = await fetch('https://open.tiktokapis.com/v2/oauth/revoke/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`tiktok revoke ${r.status}: ${text}`);
  }
}

export default async function handler(req: Request): Promise<Response> {
  const pf = handlePreflight(req);
  if (pf) return pf;

  const origin = req.headers.get('origin');

  if (req.method !== 'DELETE') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const id = extractIdFromUrl(req);
  if (!id) {
    return new Response(JSON.stringify({ error: 'missing_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  let user, supabase;
  try {
    ({ user, supabase } = await requireAdmin(req));
  } catch (e) {
    if (isResponse(e)) return e;
    logError('autopost.accounts.delete.auth', e);
    return new Response(JSON.stringify({ error: 'auth_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Look up + verify ownership in one round trip.
  const { data: account, error: selectErr } = await supabase
    .from('autopost_social_accounts')
    .select('id, user_id, platform, platform_account_id, access_token')
    .eq('id', id)
    .maybeSingle();

  if (selectErr) {
    logError('autopost.accounts.delete.select', selectErr, { id });
    return new Response(
      JSON.stringify({ error: 'db_query_failed', message: selectErr.message }),
      {
        status: 500,
        headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
      }
    );
  }
  if (!account) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const acct = account as DbAccount;
  if (acct.user_id !== user.id) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Best-effort revoke.
  let revokeError: string | null = null;
  if (acct.access_token) {
    try {
      switch (acct.platform) {
        case 'youtube':
          await revokeYouTube(acct.access_token);
          break;
        case 'instagram':
          await revokeInstagram(acct.platform_account_id, acct.access_token);
          break;
        case 'tiktok':
          await revokeTikTok(acct.access_token);
          break;
      }
    } catch (e) {
      revokeError = (e as Error).message;
      logError('autopost.accounts.delete.revoke', e, {
        id: acct.id,
        platform: acct.platform,
      });
      // Fall through and still delete the row.
    }
  }

  const { error: deleteErr } = await supabase
    .from('autopost_social_accounts')
    .delete()
    .eq('id', acct.id);

  if (deleteErr) {
    logError('autopost.accounts.delete.row', deleteErr, { id: acct.id });
    return new Response(
      JSON.stringify({ error: 'db_delete_failed', message: deleteErr.message }),
      {
        status: 500,
        headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
      }
    );
  }

  return new Response(
    JSON.stringify({ ok: true, revoked: revokeError === null, revoke_error: revokeError }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    }
  );
}
