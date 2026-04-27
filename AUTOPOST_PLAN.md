# MotionMax — Scheduled Generation & Multi-Platform Autopost Plan

**Document owner:** Jo (kameleyon)
**Last updated:** 2026-04-26
**Status:** Approved direction, admin-only soft launch, awaiting kickoff
**Audience:** Future Jo, future AI assistants, any engineer picking this up cold.
**Companion document:** `NATIVE_MOBILE_PLAN.md` — read both. The autopost feature must work identically on web, iOS, and Android.

This document is the single source of truth for adding scheduled video generation and direct multi-platform publishing (YouTube, Instagram Reels, TikTok) to MotionMax. It covers what we're building, why we're not using Supabase edge functions for the heavy path, how it integrates with the upcoming native mobile clients, how we soft-launch admin-only without touching existing user paths, and the exact build sequence.

If the window closes mid-build and someone reopens this in three months, they should be able to read this top to bottom and execute. No verbal context required.

---

## 1. Goal in one sentence

Let a creator describe a content cadence once ("3 vertical motion clips per week, posted Monday/Wednesday/Friday at 9am ET to YouTube Shorts, Instagram Reels, and TikTok"), and have MotionMax generate, render, and publish each video automatically — across web, iOS, and Android — with admin-only access for the first 4–6 weeks of operation.

---

## 2. Why this matters (do not relitigate)

- **Buffer / Hootsuite / Later** schedule existing video. They don't generate.
- **Opus Clip / Munch** clip existing long video. They don't generate.
- **MotionMax with autopost is the only product that does both end-to-end at this quality bar.** This is a new revenue tier, not a feature; pricing model in §13.
- The retention math: a user who connects a schedule retains at ~3x the rate of a one-shot user, based on autonomux's blog-cadence cohort data.

---

## 3. Architectural decision: no edge functions on the hot path

This is the core architectural choice in the document. It needs to be preserved so we don't drift back toward edge functions under deadline pressure.

### 3.1 What edge functions do well, and where they fail us
Supabase edge functions (Deno on V8 isolates) are excellent for:
- Sub-second request/response work (auth callbacks, webhook receivers, simple DB mutations).
- Workloads that fit in 50s wall clock and 256MB RAM.
- Operations a user is actively waiting on.

They fail badly for our autopost workload because:
- **Cold starts.** Even at low traffic, first-request cold start adds 800–2000ms. At scale, 5–10% of invocations cold-start. Acceptable for an auth callback, lethal for a per-minute cron tick that must finish in <60s.
- **50-second hard timeout.** YouTube resumable upload of a 100MB MP4 over a slow Vercel-to-Google connection regularly takes 70–180s. Edge function would die mid-upload, leaving the platform's upload session orphaned and burning quota.
- **No background work.** When a publish fails and needs retry-with-backoff in 5 minutes, edge functions can't sleep. We'd be polling from another timer, which is the very pattern we're avoiding.
- **No persistent connections.** OAuth refresh + multi-platform upload means many TLS handshakes. Worker can keep an HTTP/2 connection pool warm; edge function can't.
- **Cost shape.** At 1,000 active schedulers × 3 posts/week × 3 platforms = ~13,000 publishes/week. Edge fn pricing per-invocation × per-GB-second hits a wall around 5,000 active users. Long-running worker with steady CPU is cheaper at scale.

### 3.2 The right tool for each layer
| Layer | Latency budget | Stack | Hosting |
|---|---|---|---|
| **OAuth callbacks (user-facing)** | <500ms | Vercel Functions (Fluid Compute, Node.js) | Same as existing app |
| **Schedule trigger ("is it time to fire?")** | seconds | Supabase Postgres `pg_cron` + `LISTEN/NOTIFY` | Inside existing Supabase project |
| **Video generation enqueue** | seconds | Supabase Postgres trigger inserts `video_generation_jobs` row | Inside existing Supabase project |
| **Video render** | minutes to hours | **Existing FFmpeg worker** (Node, long-running, GPU-aware) | Same hosting as today (DigitalOcean / Render / Fly — wherever `worker/` runs) |
| **Multi-platform publish** | seconds to minutes | **New worker handler** in same `worker/` process | Same as render worker |
| **Token refresh** | seconds | Worker cron (every 5 min) | Same worker |
| **Webhook ingress (Meta, TikTok deletion notices)** | <500ms | Vercel Functions | Same as existing app |

### 3.3 The rule
**Anything that takes longer than 30 seconds, talks to a third-party upload endpoint, or runs on a schedule the user isn't waiting on — runs in the worker.** Edge/Vercel functions are reserved for the OAuth callback round-trip and webhook ingress.

This matches the path mobile clients will use too: they call REST endpoints that hit the worker, never edge functions for upload work.

---

## 4. Mobile compatibility (do not skip — this is why §3 matters)

The companion document `NATIVE_MOBILE_PLAN.md` describes the iOS (Swift/SwiftUI) and Android (Kotlin/Compose) rewrite. Autopost must work identically there. This means **every piece of autopost functionality is exposed as a typed REST endpoint or a Supabase realtime channel — never as a web-only client trick.**

### 4.1 Endpoints autopost adds (consumed by web + iOS + Android)
All under `https://app.motionmax.io/api/autopost/` (Vercel Functions on the OAuth/UI side) and `https://worker.motionmax.io/v1/autopost/` (worker on the heavy side):

| Endpoint | Method | Caller | Purpose |
|---|---|---|---|
| `/connect/{platform}/start` | GET | All clients | Returns OAuth authorization URL |
| `/connect/{platform}/callback` | GET | Browser/in-app browser only | Receives OAuth code, exchanges for tokens, stores in `social_accounts` |
| `/accounts` | GET | All clients | List user's connected social accounts |
| `/accounts/{id}` | DELETE | All clients | Disconnect account, revoke token at provider |
| `/schedules` | GET, POST | All clients | List/create schedules |
| `/schedules/{id}` | GET, PATCH, DELETE | All clients | Manage individual schedule |
| `/schedules/{id}/preview` | POST | All clients | Dry-run: generate video without publishing |
| `/schedules/{id}/runs` | GET | All clients | History of past runs with thumbnails + platform post URLs |
| `/publish/test` | POST | All clients | Manual one-off publish of an existing video to selected platforms |

Realtime channel `autopost:user=<id>` carries: `schedule_fired`, `video_ready`, `publish_started`, `publish_succeeded`, `publish_failed`. Native clients subscribe to this for live progress.

### 4.2 Native-client specifics
- **iOS OAuth flows** use `ASWebAuthenticationSession` for the consent flow, then deep-link back to the app on the `motionmax://` scheme. The Vercel Function callback redirects to that scheme after token exchange.
- **Android OAuth flows** use Custom Tabs with the same callback pattern.
- **Push notifications**: when a publish succeeds or fails, native clients get an APNs / FCM push (sent from worker after the realtime broadcast). Web gets a service-worker notification if granted.
- **No platform-specific upload logic on the client.** The app never calls YouTube/IG/TikTok directly. It only calls our worker, which holds the tokens. This keeps tokens out of mobile keychain risk and means a token leak is server-side, not 10,000 device-side.

### 4.3 What this rules out
- "Just use Vercel edge for the publish endpoint and call it from iOS." Rejected — same 50s timeout problem, same cold-start, plus mobile is more sensitive to dropped connections than web.
- "Let mobile do the upload directly with stored tokens." Rejected — tokens on device is a bigger attack surface and complicates the audit submissions to TikTok/Meta.

---

## 5. Admin-only soft launch (the path that doesn't touch existing settings)

This is the §5 Jo specifically asked for: build the whole thing on a dedicated path so it can't break anything in the current app for current users.

### 5.1 The dedicated route tree
Add a new top-level route `/lab` (short for laboratory — admin-only feature flagging area, will host future experiments too):

```
/lab                          → admin-only landing
  /lab/autopost              → autopost dashboard
  /lab/autopost/connect      → connect social accounts
  /lab/autopost/schedules    → list + create schedules
  /lab/autopost/schedules/:id → edit schedule
  /lab/autopost/runs         → history
  /lab/autopost/runs/:id     → run detail with thumbnails + post URLs
```

Routing changes are **additive only**. We do not touch `/app`, `/app/legacy`, `/usage`, `/editor`, `/auth`, or any existing route. New routes mount in `src/App.tsx` after the existing ones, gated by an `<AdminOnlyRoute>` wrapper.

### 5.2 Admin gate (zero risk to non-admins)
Add a column to `profiles`:

```sql
alter table profiles
  add column is_lab_user boolean not null default false;

-- Jo flips own row manually
update profiles set is_lab_user = true where email = 'arcanadraconi@gmail.com';
```

`<AdminOnlyRoute>` reads `profiles.is_lab_user` for the current session. Anyone else hitting `/lab/*` redirects to `/app`. No existing UI links to `/lab` — Jo bookmarks it.

When the soft-launch period ends (week 6 or 8 depending on review timing), we either:
- Promote `/lab/autopost` to `/autopost` and add a sidebar entry for plans `studio` and `enterprise`, **or**
- Keep `/lab` as the admin sandbox forever and graduate features out of it as they harden.

Either way, **no existing route changes shape during soft launch.**

### 5.3 Database isolation
All new tables prefixed `autopost_` (per §6). RLS policies require `is_lab_user = true` during soft launch. When we open up to studio plan, the policy changes from `is_lab_user` to `plan_name in ('studio', 'enterprise') and autopost_enabled = true`. One ALTER POLICY statement.

### 5.4 Worker isolation
Autopost work runs in a dedicated worker queue (`autopost_publish_jobs`) consumed by a dedicated handler (`worker/src/handlers/autopost/`). Existing render handlers (`worker/src/handlers/export/`, `scene_render`, etc.) are untouched. If the autopost handler crashes, render keeps running. If render is overloaded, autopost still ticks.

### 5.5 Feature flag at every boundary
Three independent kill switches:
1. **Database flag** — `app_settings.autopost_enabled` global boolean. Worker checks every tick. Set to `false` and the whole system stops, no deploy needed.
2. **Per-user flag** — `profiles.is_lab_user` (soft launch) → `profiles.autopost_enabled` (post-launch).
3. **Per-platform flag** — `app_settings.autopost_youtube_enabled` / `autopost_instagram_enabled` / `autopost_tiktok_enabled`. If TikTok's audit comes back rejected and we need to disable that path while we appeal, one toggle.

---

## 6. Data model (additive only)

All new tables. No alterations to existing tables except the one column on `profiles`.

```sql
-- 6.1 Connected social accounts (one user, many platforms, multiple accounts per platform allowed)
create table autopost_social_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'instagram', 'tiktok')),
  platform_account_id text not null,            -- e.g., YouTube channel ID, IG business account ID
  display_name text not null,                   -- shown in UI
  avatar_url text,
  access_token text not null,                   -- encrypted at rest via pgsodium (column-level)
  refresh_token text,                           -- encrypted
  token_expires_at timestamptz,
  scopes text[] not null,
  status text not null default 'connected' check (status in ('connected', 'expired', 'revoked', 'error')),
  last_error text,
  connected_at timestamptz not null default now(),
  unique (user_id, platform, platform_account_id)
);

-- 6.2 Recurring schedules
create table autopost_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  active boolean not null default true,

  -- generation
  prompt_template text not null,               -- e.g., "{day} motivation: {topic}"
  topic_pool text[],                           -- rotated through, one per fire
  motion_preset text,                          -- nullable = random from a curated set
  duration_seconds int not null default 30,
  resolution text not null default '1080x1920', -- vertical default

  -- schedule
  cron_expression text not null,               -- e.g., '0 9 * * 1,3,5' for M/W/F 9am
  timezone text not null default 'America/New_York',
  next_fire_at timestamptz not null,           -- denormalized for fast cron tick

  -- targets
  target_account_ids uuid[] not null,          -- array of autopost_social_accounts.id
  caption_template text,                       -- supports {date}, {topic}, {schedule_name}
  hashtags text[],
  ai_disclosure boolean not null default true, -- always true at launch

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 6.3 Each schedule fire produces a run, runs hold publish jobs per platform
create table autopost_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references autopost_schedules(id) on delete cascade,
  fired_at timestamptz not null default now(),
  topic text,                                   -- the topic chosen this run
  prompt_resolved text not null,                -- final prompt after template substitution
  video_job_id uuid references video_generation_jobs(id),
  status text not null default 'queued' check (status in
    ('queued', 'generating', 'rendered', 'publishing', 'completed', 'failed', 'cancelled')),
  error_summary text
);

create table autopost_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references autopost_runs(id) on delete cascade,
  social_account_id uuid not null references autopost_social_accounts(id) on delete cascade,
  platform text not null,                       -- denormalized for query speed
  status text not null default 'pending' check (status in
    ('pending', 'uploading', 'processing', 'published', 'failed', 'rejected')),
  attempts int not null default 0,
  last_attempt_at timestamptz,
  scheduled_for timestamptz,                    -- can be different from run.fired_at if platform staggers
  platform_post_id text,                        -- YouTube videoId, IG media id, TikTok publish id
  platform_post_url text,
  error_code text,
  error_message text,
  caption text,                                 -- final caption per platform (length-trimmed)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 6.4 Global feature flags (one row, app-wide)
create table app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into app_settings(key, value) values
  ('autopost_enabled', 'false'::jsonb),
  ('autopost_youtube_enabled', 'true'::jsonb),
  ('autopost_instagram_enabled', 'true'::jsonb),
  ('autopost_tiktok_enabled', 'true'::jsonb);

-- 6.5 RLS — soft launch policy (admin only)
alter table autopost_social_accounts enable row level security;
alter table autopost_schedules enable row level security;
alter table autopost_runs enable row level security;
alter table autopost_publish_jobs enable row level security;

create policy "lab users own their social accounts"
  on autopost_social_accounts for all
  using (
    auth.uid() = user_id
    and exists (select 1 from profiles where profiles.id = auth.uid() and profiles.is_lab_user = true)
  );
-- Same shape policies on schedules, runs, publish_jobs (joined through schedule → run → publish_job).
```

Token columns use pgsodium (Supabase's column-level encryption). The worker reads tokens via the `service_role` key, decrypts in memory, never logs them. Frontend never reads tokens — only metadata (display_name, status, expires_at).

---

## 7. The schedule-tick mechanism

> Reminder: every "Postgres" reference here is the **Supabase Postgres database that already ships with your project** (`ayjbvcikuwknqdrpsdmj`). No separate database is being installed. `pg_cron` and `LISTEN/NOTIFY` are extensions/features of that existing Supabase database — enable `pg_cron` from Supabase Dashboard → Database → Extensions if it isn't already on.

`pg_cron` runs every minute (managed inside Supabase, visible at Database → Cron Jobs in the dashboard) and calls a Postgres function `autopost_tick()`:

```sql
select cron.schedule(
  'autopost-tick',
  '* * * * *',
  $$ select autopost_tick(); $$
);
```

`autopost_tick()` does, in a single transaction:
1. `select id from autopost_schedules where active = true and next_fire_at <= now()` (uses index on `next_fire_at`).
2. For each, compute the next fire time from `cron_expression` + `timezone`, update `next_fire_at`.
3. Insert a row into `autopost_runs` with status `queued`.
4. `pg_notify('autopost_run_created', run.id)`.

The worker listens on `autopost_run_created`. When notified, it:
1. Picks a topic from `topic_pool` (round-robin or random based on schedule config).
2. Resolves the prompt template.
3. Inserts a `video_generation_jobs` row tagged with `metadata = {autopost_run_id: ...}` so the existing render pipeline picks it up unchanged.
4. Updates `autopost_runs.status = 'generating'`.

When the render completes, an `AFTER UPDATE` trigger on `video_generation_jobs` checks if the row has an `autopost_run_id` in metadata and `status = 'completed'`. If so, it:
1. Updates `autopost_runs.status = 'rendered'`.
2. Inserts one `autopost_publish_jobs` row per `target_account_id`.
3. `pg_notify('autopost_publish', publish_job.id)`.

The publisher worker listens on `autopost_publish`, fans out per-platform handlers.

**Why notifications instead of polling:** with thousands of schedules, polling every second is 86,400 wasted queries per day. `LISTEN/NOTIFY` is push, sub-millisecond latency, and Supabase Realtime (which is reading the same WAL on the same database) forwards the same events to web/iOS/Android clients for free over WebSocket.

**One database, one truth.** All of this — tables, triggers, cron, notifications, realtime — runs inside the single Supabase project we already have. Nothing about autopost requires standing up a second database, a queue service, or an external scheduler.

---

## 8. Per-platform publish handlers

Each handler lives at `worker/src/handlers/autopost/<platform>.ts` and implements the same interface:

```ts
interface PublishHandler {
  publish(job: AutopostPublishJob, account: SocialAccount, video: RenderedVideo): Promise<PublishResult>;
  refreshTokenIfNeeded(account: SocialAccount): Promise<SocialAccount>;
}
```

### 8.1 YouTube (Shorts)
- **OAuth scope**: `https://www.googleapis.com/auth/youtube.upload`.
- **Upload**: resumable upload protocol. Initiate with `POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, get session URL, `PUT` the bytes in chunks of 8MB. Resumable means a network blip doesn't restart from zero.
- **Quota cost**: 1,600 units per upload. Default 10,000/day = 6 uploads. **File quota increase request the day we start coding** — typical approval 1–2 weeks.
- **Shorts trigger**: video must be ≤60s and vertical (9:16). Add `#Shorts` to title or description as a hint.
- **AI disclosure**: set `status.containsSyntheticMedia = true` (YouTube's altered/synthetic content flag, mandatory for AI-generated content as of 2024).
- **Failure modes**: 403 quota → backoff until tomorrow + alert Jo. 401 expired → refresh token, retry once. 5xx → exponential backoff up to 3 attempts.

### 8.2 Instagram Reels
- **Account requirement**: connected IG Business account (not Creator, not personal). UI must check this and instruct user to convert if needed.
- **Two-step publish**:
  1. `POST /{ig-user-id}/media` with `media_type=REELS&video_url=<our public url>&caption=<text>` → returns container ID.
  2. Poll `GET /{container-id}?fields=status_code` every 5s until `FINISHED` (typical 30–90s for short reels).
  3. `POST /{ig-user-id}/media_publish?creation_id=<container-id>` → returns media ID.
- **video_url**: Meta fetches our public URL. We expose rendered video at `https://cdn.motionmax.io/render/<job-id>.mp4` with a 1-hour signed URL, then revoke after publish confirmed.
- **Constraints**: ≤90s, ≤100MB, 9:16, ≤30fps, audio embedded (no IG music library via API).
- **Permissions**: `instagram_business_basic` + `instagram_business_content_publish` — Meta App Review (1–4 weeks).
- **Side benefit**: if the IG Business account is linked to a Facebook Page, the post auto-cross-publishes to Facebook Reels with no extra integration. Free win.

### 8.3 TikTok (Direct Post)
- **OAuth scope**: `video.publish`.
- **Direct Post**: `POST /v2/post/publish/video/init/` with metadata + chunk plan, then upload chunks to returned URL, then `POST /v2/post/publish/status/fetch/` to confirm.
- **Audit gate**: until our app passes audit, every post is private-only. **Submit audit application same day as Meta App Review.**
- **Caps**: ~15 posts/day per creator account, shared across all clients using Direct Post API.
- **AI disclosure**: set `ai_generated_content` flag in init payload.
- **No watermarks/branding overlays** in the posted content (TikTok rule, enforced at audit).

### 8.4 Shared retry + dead-letter logic
All three handlers share `worker/src/handlers/autopost/retryPolicy.ts`:
- Attempt 1 immediate.
- Attempt 2 after 60s.
- Attempt 3 after 5 minutes.
- After 3 failures → status `failed`, `pg_notify('autopost_publish_failed', job.id)`, push notification + email to user.
- Token-expired errors short-circuit retry: refresh, then immediate retry once. If refresh fails, mark account `status = 'expired'`, surface in UI.

---

## 9. UI surface (admin-only at `/lab/autopost`)

### 9.1 Connect accounts page
- One card per platform (YouTube, Instagram, TikTok).
- Each card shows connected accounts (display_name + avatar) or a "Connect" button.
- "Connect" launches OAuth flow via Vercel Function `/api/autopost/connect/{platform}/start`.
- Disconnect button revokes at provider, deletes our row.

### 9.2 Schedule list
- Table: Name, Cron (humanized: "Mon, Wed, Fri at 9:00 AM ET"), Platforms (icon stack), Active toggle, Next fire, Actions.
- "New schedule" button → wizard.

### 9.3 Schedule wizard (4 steps)
1. **What to make** — prompt template, topic pool (one per line), motion preset selector, duration, resolution.
2. **When** — cron builder UI (presets like "3x/week" or "daily 9am" + custom cron field), timezone.
3. **Where** — checkbox list of connected accounts grouped by platform, caption template per platform (different lengths/styles), hashtags.
4. **Review + Test** — shows next 5 fire times, "Generate test video now" button (fires once without scheduling, video appears in run history but `autopost_publish_jobs.status = 'pending'` requires manual approval to actually post).

### 9.4 Run history
- Reverse-chronological list of `autopost_runs`.
- Each row: thumbnail (auto-generated from rendered MP4), schedule name, fired_at, status, per-platform pill with link to live post if `published`.
- Click row → detail with full prompt, generation log, per-platform timeline (uploaded/processing/published timestamps), error messages if any.

### 9.5 The "/lab" admin landing
Plain page listing experiments (just "Autopost" for now). Future: this is where we put any admin-gated trial feature so they can't bleed into production UX.

---

## 10. Build sequence

Eleven phases, ordered by dependency. Phases 1–3 are pure web + backend. Phase 11 (mobile parity) starts only after the iOS editor shell from `NATIVE_MOBILE_PLAN.md` Phase 4 lands — we don't build autopost UI on platforms whose shells don't exist yet. The endpoints from §4.1 are mobile-ready from day one regardless.

| # | Phase | Depends on | Output |
|---|---|---|---|
| 1 | **Schema + RLS + flags** | — | Migrations for §6 tables, pgsodium setup for token columns, app_settings seeded, `is_lab_user` column added, Jo's row flipped. |
| 2 | **Admin gate + `/lab` route shell** | 1 | `<AdminOnlyRoute>` component, empty `/lab` and `/lab/autopost` pages. Verify non-admins redirect cleanly. |
| 3 | **OAuth: YouTube** | 2 | `/api/autopost/connect/youtube/start` + callback Vercel Functions. Tokens stored encrypted. Connect/disconnect UI. **File YouTube quota increase application end of this phase.** |
| 4 | **OAuth: Instagram** | 2 | Same shape. **Submit Meta App Review at end of this phase** for `instagram_business_basic` + `instagram_business_content_publish`. |
| 5 | **OAuth: TikTok** | 2 | Same shape. **Submit TikTok audit at end of this phase.** Until approved, posts are private-only — that's fine for soft launch since Jo is the only user. |
| 6 | **Schedule + run schema wiring** | 1 | `pg_cron` job, `autopost_tick()` function, trigger on `video_generation_jobs` updates. End-to-end: a schedule fires → video gets generated → publish jobs are created → all visible in Postgres. No actual publishing yet. |
| 7 | **Worker handler scaffold + retry policy** | 6 | `worker/src/handlers/autopost/` with shared retry, dead-letter, token refresh. Stub publish handlers that just mark `published` without actually calling platform. End-to-end runs but doesn't post. |
| 8 | **YouTube publish handler** | 7 | Real resumable upload, real video on Jo's test channel. |
| 9 | **Instagram publish handler** | 7 | Real container/publish flow. Requires Meta App Review approval (file in §4); use sandbox if review still pending. |
| 10 | **TikTok publish handler** | 7 | Real Direct Post. Private-only until audit clears. |
| 11 | **Schedule wizard + run history UI** | 7 | The `/lab/autopost/schedules/new` wizard, list, detail page, thumbnail generation. |
| 12 | **Mobile parity (iOS)** | 11 + `NATIVE_MOBILE_PLAN.md` Phase 4 | SwiftUI Autopost feature module under `MMAutopost` package. Reuses the same REST endpoints from §4.1. |
| 13 | **Mobile parity (Android)** | 12 | Compose mirror under `core-autopost` module. |

---

## 11. Timeline

Single engineer (Jo) + AI agents. Realistic, not aspirational.

### 11.1 Web admin-only soft launch (the first deliverable)
| Weeks | Phases | Milestone |
|---|---|---|
| 1 | 1, 2 | Schema deployed. `/lab` route gated. Jo can hit it. |
| 2 | 3, 4, 5 | All three OAuth flows working. **Three review applications filed in parallel by end of week 2.** |
| 3 | 6, 7 | Tick + run flow end-to-end with stub publishers. |
| 4 | 8 | YouTube real publishing live (assuming quota increase landed). |
| 5 | 9, 10 | IG + TikTok real publishing live (subject to review approvals). |
| 6 | 11 | Wizard + history UI polished. **Soft launch complete: Jo can run autopost on his own accounts.** |

**End of week 6: web admin-only autopost shipped.** If a review hasn't come back, that platform's publish stays in stub mode but everything else works.

### 11.2 Wider launch
- **Weeks 7–8**: Reviews cycle if any rejected. Iterate. Add observability (logs, metrics, error rates per platform).
- **Week 9**: Open to `studio` plan users. RLS policy alters from `is_lab_user` to `plan_name in ('studio','enterprise') and autopost_enabled = true`. UI sidebar entry added. `/lab/autopost` graduates to `/autopost`.

### 11.3 Mobile parity (Phases 12–13)
Tracks alongside `NATIVE_MOBILE_PLAN.md`. Autopost mobile UI starts only when the editor shell is in place there — earliest week 4 of mobile track per that document.

| Mobile track week | Autopost milestone |
|---|---|
| Mobile week 4 (after editor shell) | iOS: connect accounts screen + schedule list (read-only) |
| Mobile week 5 | iOS: schedule wizard + run history |
| Mobile week 6 | iOS: push notifications on publish events |
| Mobile week 7+ | Android mirror |

**Mobile autopost ships within the same window as the rest of mobile parity** — no separate timeline needed.

---

## 12. Risks and mitigations

### 12.1 Review queue is the only real timeline risk
YouTube quota increase (1–2 weeks), Meta App Review (1–4 weeks), TikTok audit (5–10 business days). All three filed at end of week 2 means worst case is week 6 still has one outstanding. Mitigation already baked into §11.1: each platform handler can ship in stub mode and hot-swap to real mode the day approval lands.

### 12.2 Token refresh failures at scale
Refresh tokens expire on different cadences (Google ~6 months idle, Meta ~60 days, TikTok ~365 days). At 1,000 connected accounts, a refresh storm could rate-limit us. Mitigation: refresh proactively at 80% of expiry, stagger across the 24h window using `account_id % 1440` minute buckets.

### 12.3 Content moderation strikes hit the user, not us
If TikTok flags a generated video as undisclosed AI content, the *user's* TikTok account gets a strike. We mitigate by always setting the AI disclosure flag at upload (§8.1, §8.3), defaulting `ai_disclosure = true` on every schedule, and refusing to disable it at the UI level until the user explicitly acknowledges the risk.

### 12.4 Platform API changes
Meta and TikTok have shipped breaking changes mid-year before. Mitigation: pin SDK/API versions explicitly, integration tests against each platform's sandbox, alert on first 5xx spike per platform. Keep `app_settings.autopost_<platform>_enabled` as the kill switch.

### 12.5 Edge function regression pressure
When someone (future Jo, future contractor) sees a Vercel Function in the OAuth path and asks "why isn't the publish there too?" — the answer lives in §3 of this document. Read it before changing the architecture.

### 12.6 Cost runaway on rendering
Each scheduled fire = one render. At 1,000 users × 3/week = 12,000 renders/month. Worker compute is the dominant cost. Mitigation: per-plan fire caps enforced in `autopost_tick()` (e.g., studio = 50/month, enterprise = 500/month), block schedule activation if it would exceed monthly cap.

---

## 13. Pricing model (soft target)

Not part of this build, but documented so the architecture supports it:

| Tier | Renders/mo | Connected accounts | Autopost fires/mo | Price |
|---|---|---|---|---|
| Free | 10 | 0 | 0 | $0 |
| Creator | 50 | 1 per platform | 0 | $19 |
| Studio | 200 | 3 per platform | 50 | $79 |
| **Studio Pro** *(new tier for autopost)* | 500 | 10 per platform | 200 | $199 |
| Enterprise | Custom | Unlimited | Custom | Custom |

The schema already supports this — `autopost_schedules` are limited by counting active rows per user, and `autopost_runs.fired_at` per month gives the cap check.

---

## 14. Window-closes-today resumption

If this conversation ends and Jo picks it up in three months:

1. **Read `NATIVE_MOBILE_PLAN.md` and this document top to bottom.** They share an audience and an architecture.
2. **Check git for `worker/src/handlers/autopost/`, `src/pages/lab/`, and migrations matching `autopost_*`.** Their existence tells you which phases are done.
3. **Check Supabase for `app_settings.autopost_enabled` value** — if true, the system is live for whoever the RLS policy currently allows.
4. **Check status of three review applications**: YouTube quota increase (Google Cloud Console → quotas), Meta App Review (developers.facebook.com), TikTok audit (developers.tiktok.com). If any is still pending, do not block on it — phase 8/9/10 ship in stub mode regardless.
5. **Verify the §3 architectural decision still stands.** Anyone arguing for moving publishers into edge functions has not read §3.1.
6. **Verify the §4 native compatibility rule still stands.** Mobile clients consume the REST endpoints, not direct platform APIs.

### 14.1 Files this document depends on (do not delete)
- `worker/` — all autopost work runs here. Do not move handlers to edge functions.
- `src/App.tsx` — `/lab/*` routes mount here behind `<AdminOnlyRoute>`.
- `src/pages/lab/` — admin-only UI lives here. Do not link from main nav until graduation.
- `supabase/migrations/` — autopost schema lives here. Pgsodium key setup is in the first autopost migration.
- `NATIVE_MOBILE_PLAN.md` — companion doc. Mobile autopost waits for editor shell.

### 14.2 Conversation context that matters
- Jo is the only intended user during weeks 1–6. RLS policy enforces this via `is_lab_user`. Do not add UI links to `/lab` from anywhere users can see.
- Autonomux pattern (https://github.com/kameleyon/autonomux-ai-hub) inspired the schedule + cron architecture but does email delivery, not platform publishing. Pattern transfers; transport doesn't.
- The "edge functions are not the path" decision was specifically called out by Jo during the planning conversation. Don't reverse it without re-reading §3.

---

## 15. Success criteria

The autopost feature is "done" when all are true:

1. Jo's `/lab/autopost` works end-to-end: connect 3 platforms, create 1 schedule, see it fire, see videos render, see them publish, see history with live post URLs.
2. All three platform reviews approved (YouTube quota, Meta App Review, TikTok audit).
3. Worker handles 100 publishes/hour without queue backup.
4. Token refresh runs unattended for 30 days with zero stuck accounts.
5. Failure modes (quota, expired token, platform 5xx, content rejection) all surface clearly in run history with actionable messages.
6. iOS and Android `MMAutopost` / `core-autopost` modules consume the same REST endpoints with no platform-specific upload code.
7. Studio plan users can self-serve the wizard at `/autopost` (post-graduation).
8. Crash-free worker run for 7 consecutive days.

Anything below these bars is not "done"; it's "released early."

---

**End of document.** If you're an AI assistant resuming this work, your first action is `Read` on this file in full, then `Read` on `NATIVE_MOBILE_PLAN.md`, then `git status` + scan for the directories listed in §14.1, then check Supabase migration history. Do not move any handler from `worker/` into a Supabase edge function. Do not link `/lab` from main nav. Do not skip the AI-content disclosure flag on any platform.
