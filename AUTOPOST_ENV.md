# MotionMax Autopost — Environment Variables

**Companion to:** `AUTOPOST_PLAN.md`, `AUTOPOST_ROADMAP.md`
**Owner:** Wave 2a (OAuth Vercel Functions)
**Last updated:** 2026-04-28

This file lists every environment variable required by the autopost
Vercel Functions in `api/autopost/*`. Set each one in the Vercel
dashboard (Project → Settings → Environment Variables) for **Production**
and **Preview** environments. For local development copy the same values
into `.env.local` (already gitignored).

The OAuth Vercel Functions are designed to **fail soft** when these
env vars are missing — instead of crashing, they return HTTP 503 with a
JSON body like `{"error": "youtube_oauth_not_configured", ...}`. The UI
can render a "configure first" state from that.

---

## Server-only (never exposed to the browser)

| Variable | Purpose | Example / format |
|---|---|---|
| `SUPABASE_URL` | Supabase project URL for the service-role client. Same value as `VITE_SUPABASE_URL` but without the `VITE_` prefix so Vercel Functions can read it server-side. | `https://ayjbvcikuwknqdrpsdmj.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role JWT. Bypasses RLS. Keep encrypted, never log. | `eyJhbGciOi…` |
| `OAUTH_STATE_SECRET` | HMAC-SHA256 key used to sign state tokens during OAuth. Must be ≥32 chars. | Generate with `openssl rand -hex 32` |
| `APP_URL` | Public origin used for redirect URIs. **Must match** the redirect URI registered with each OAuth provider. | `https://app.motionmax.io` |

## Per-platform OAuth credentials

### YouTube (Google Cloud OAuth client)
| Variable | Where to get it |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Same OAuth client → "Client secret" |

Authorized redirect URI to register at Google:
`{APP_URL}/api/autopost/connect/youtube/callback`

### Instagram (Meta Graph)
| Variable | Where to get it |
|---|---|
| `META_APP_ID` | developers.facebook.com → Apps → MotionMax → Settings → Basic → App ID |
| `META_APP_SECRET` | Same screen → "App secret" |

Authorized redirect URI: `{APP_URL}/api/autopost/connect/instagram/callback`
(Add to Facebook Login → Settings → Valid OAuth Redirect URIs.)

### TikTok (Login Kit + Content Posting API)
| Variable | Where to get it |
|---|---|
| `TIKTOK_CLIENT_KEY` | developers.tiktok.com → Manage apps → MotionMax → Basic info |
| `TIKTOK_CLIENT_SECRET` | Same screen — "Client secret" (revealed once, store immediately) |

Redirect URI: `{APP_URL}/api/autopost/connect/tiktok/callback`

---

## Local development quick-start

```bash
# .env.local (gitignored; never commit)

SUPABASE_URL=https://ayjbvcikuwknqdrpsdmj.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ…
OAUTH_STATE_SECRET=$(openssl rand -hex 32)
APP_URL=http://localhost:8080

GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
META_APP_ID=
META_APP_SECRET=
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
```

Run `vercel dev` to test the OAuth flows locally; the Vercel CLI loads
`.env.local` automatically. For each platform, register the localhost
redirect URI alongside the production URI so the same client works in
both.

---

## Verification checklist

- [ ] All 9 server-only env vars present in Vercel dashboard for Production
- [ ] All 9 also present for Preview (or fall back gracefully)
- [ ] `OAUTH_STATE_SECRET` is ≥32 characters and unique per environment
- [ ] Each platform redirect URI registered at the provider matches `{APP_URL}/api/autopost/connect/{platform}/callback`
- [ ] No env var values appear in client bundles (none of these have a `VITE_` prefix, so they shouldn't — but search the build output to be sure)
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is marked "Sensitive" in Vercel so it's encrypted at rest
