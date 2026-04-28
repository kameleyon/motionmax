/**
 * OAuth token refresher for autopost_social_accounts.
 *
 * Runs every 5 minutes. Finds connected accounts whose token expires within
 * the next 20 minutes and that have a refresh_token, then calls the
 * provider's refresh endpoint via built-in fetch (no axios, no SDK) and
 * writes the new access_token + token_expires_at back to the row.
 *
 * Failure is non-fatal: the row is marked status='expired' with last_error,
 * and the worker keeps running. The user is expected to reconnect the
 * account from the autopost UI.
 *
 * Instagram is intentionally a no-op. Meta long-lived page tokens last 60
 * days and Wave 2a's OAuth callback handler is responsible for refreshing
 * them on a separate cadence (the long-lived exchange happens at connect
 * time and again at user action).
 */

import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";
import type { SocialAccount } from "./types.js";

const REFRESH_INTERVAL_MS = 5 * 60_000;
/** Refresh tokens that expire within this window. */
const REFRESH_AHEAD_MS = 20 * 60_000;

let started = false;

export function startTokenRefresher(): void {
  if (started) return;
  started = true;
  setInterval(refresh, REFRESH_INTERVAL_MS);
  void refresh();
}

/**
 * Inline-callable single-account refresh, used by the dispatcher when a
 * publisher returns 'token_expired' mid-flight. Returns the refreshed
 * SocialAccount row on success, or null on failure (callers must handle
 * the null case — we deliberately do not throw because the caller will
 * fall through to the normal retry path on null).
 *
 * Loads the row fresh from the DB (so a token rotated by the periodic
 * refresher between the publish attempt and now is honored), runs the
 * provider-specific refresh, and returns the up-to-date row.
 */
export async function refreshAccountToken(accountId: string): Promise<SocialAccount | null> {
  try {
    const { data: row, error } = await supabase
      .from("autopost_social_accounts")
      .select("*")
      .eq("id", accountId)
      .maybeSingle();
    if (error || !row) return null;
    const acct = row as SocialAccount;

    switch (acct.platform) {
      case "youtube":
        await refreshYoutube(acct);
        break;
      case "tiktok":
        await refreshTikTok(acct);
        break;
      case "instagram":
        // Meta long-lived tokens are not refreshable via this path; signal
        // the caller to fall through to the standard retry handling.
        return null;
      default:
        return null;
    }

    // Re-read so the caller sees the freshly-written access_token.
    const { data: updated } = await supabase
      .from("autopost_social_accounts")
      .select("*")
      .eq("id", accountId)
      .maybeSingle();
    return (updated as SocialAccount | null) ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeSystemLog({
      category: "system_warning",
      eventType: "autopost_inline_token_refresh_failed",
      message: `Inline token refresh failed for account ${accountId}: ${msg}`,
      details: { accountId },
    });
    return null;
  }
}

async function refresh(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() + REFRESH_AHEAD_MS).toISOString();

    const { data: accounts, error } = await supabase
      .from("autopost_social_accounts")
      .select("*")
      .eq("status", "connected")
      .lt("token_expires_at", cutoff)
      .not("refresh_token", "is", null);

    if (error) {
      console.warn(`[Autopost] token refresh query failed: ${error.message}`);
      return;
    }

    if (!accounts || accounts.length === 0) return;

    for (const acct of accounts as SocialAccount[]) {
      try {
        switch (acct.platform) {
          case "youtube":
            await refreshYoutube(acct);
            break;
          case "tiktok":
            await refreshTikTok(acct);
            break;
          case "instagram":
            // Meta long-lived page tokens — handled out of band.
            break;
          default:
            // Unknown platform; leave row alone but log.
            console.warn(`[Autopost] token refresh: unknown platform ${(acct as { platform?: string }).platform}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await supabase
          .from("autopost_social_accounts")
          .update({ status: "expired", last_error: msg })
          .eq("id", acct.id);
        await writeSystemLog({
          userId: acct.user_id,
          category: "system_warning",
          eventType: "autopost_token_refresh_failed",
          message: `Token refresh failed for ${acct.platform} account ${acct.id}: ${msg}`,
          details: { accountId: acct.id, platform: acct.platform },
        });
      }
    }
  } catch (err) {
    console.error(
      `[Autopost] token refresher exception: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Google OAuth 2.0 refresh.
 * Docs: https://developers.google.com/identity/protocols/oauth2/web-server#offline
 */
async function refreshYoutube(acct: SocialAccount): Promise<void> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn(`[Autopost] GOOGLE_OAUTH_CLIENT_ID/SECRET not set — skipping YouTube refresh for ${acct.id}`);
    return;
  }
  if (!acct.refresh_token) return;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: acct.refresh_token,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`google refresh ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };

  if (!json.access_token) {
    throw new Error("google refresh: no access_token in response");
  }

  const expiresInSec = typeof json.expires_in === "number" ? json.expires_in : 3600;
  const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

  const update: Record<string, unknown> = {
    access_token: json.access_token,
    token_expires_at: tokenExpiresAt,
    last_error: null,
  };
  // Google sometimes rotates refresh tokens; keep the new one if present.
  if (json.refresh_token) update.refresh_token = json.refresh_token;

  const { error } = await supabase
    .from("autopost_social_accounts")
    .update(update)
    .eq("id", acct.id);

  if (error) throw new Error(`db update failed: ${error.message}`);
}

/**
 * TikTok OAuth refresh.
 * Docs: https://developers.tiktok.com/doc/oauth-user-access-token-management/
 */
async function refreshTikTok(acct: SocialAccount): Promise<void> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    console.warn(`[Autopost] TIKTOK_CLIENT_KEY/SECRET not set — skipping TikTok refresh for ${acct.id}`);
    return;
  }
  if (!acct.refresh_token) return;

  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: acct.refresh_token,
  });

  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`tiktok refresh ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (json.error) {
    throw new Error(`tiktok refresh error: ${json.error} ${json.error_description ?? ""}`);
  }
  if (!json.access_token) {
    throw new Error("tiktok refresh: no access_token in response");
  }

  const expiresInSec = typeof json.expires_in === "number" ? json.expires_in : 86400;
  const tokenExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

  const update: Record<string, unknown> = {
    access_token: json.access_token,
    token_expires_at: tokenExpiresAt,
    last_error: null,
  };
  if (json.refresh_token) update.refresh_token = json.refresh_token;

  const { error } = await supabase
    .from("autopost_social_accounts")
    .update(update)
    .eq("id", acct.id);

  if (error) throw new Error(`db update failed: ${error.message}`);
}
