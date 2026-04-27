# MotionMax — Autopost Roadmap Checklist

**Companion to:** `AUTOPOST_PLAN.md` (architecture) + `NATIVE_MOBILE_PLAN.md` (mobile parity)
**Mode:** Admin-only soft launch on `/lab/autopost`, Jo as sole user during weeks 1–6
**Last updated:** 2026-04-26
**How to use this doc:** Tick boxes as you go. Each phase has a clear "definition of done" at the bottom. Don't move to the next phase until all boxes in the current one are checked. If a box is blocked (e.g., review pending), note it in the box and move on; don't fake-complete.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked (annotate why)

---

## Phase 0 — Pre-flight (Day 0, ~2 hours)

Before any code is written. Do these in order.

### 0.1 Decisions Jo must make before kickoff
- [ ] Confirm route prefix: **`/lab/autopost`** (default) — change here if different
- [ ] Confirm initial admin email: **`arcanadraconi@gmail.com`** + **`josinsidevoice@gmail.com`** (both flipped to `is_lab_user = true`)
- [ ] Confirm pricing intent: Studio Pro tier at $199/mo gates autopost post-graduation (per `AUTOPOST_PLAN.md` §13)
- [ ] Confirm video defaults: **30s, 1080×1920 vertical, no watermark on paid tiers**
- [ ] Confirm AI-disclosure default: **always `true` at launch, no UI toggle to disable**

### 0.2 Accounts and access verification
- [ ] Verify Jo has a YouTube channel ready for testing (kameleyon's existing or create `motionmax-test`)
- [ ] Verify Jo has an Instagram **Business** account (not Creator, not personal). Convert if needed.
- [ ] Verify the IG Business account is linked to a Facebook Page (gives free FB Reels cross-post)
- [ ] Verify Jo has a TikTok account in good standing (no recent strikes)
- [ ] Confirm Supabase project ID `ayjbvcikuwknqdrpsdmj` is the target — not a new project
- [ ] Confirm worker host has spare capacity (check current CPU + RAM headroom)

### 0.3 Documentation cross-checks
- [ ] Re-read `AUTOPOST_PLAN.md` §3 (the no-edge-functions rule)
- [ ] Re-read `AUTOPOST_PLAN.md` §4 (the mobile-compatible REST surface)
- [ ] Re-read `AUTOPOST_PLAN.md` §5 (the admin-only `/lab` isolation strategy)
- [ ] Re-read `NATIVE_MOBILE_PLAN.md` §4–5 to confirm endpoint shapes match

### Phase 0 Definition of Done
All decisions captured in writing. All test accounts confirmed. No code written yet.

---

## Phase 1 — Schema, RLS, Feature Flags (Week 1, Days 1–3)

Everything additive. Touches no existing tables except adding one column to `profiles`.

### 1.1 Migrations
- [ ] Create migration `20260427000001_autopost_schema.sql` with all `autopost_*` tables from `AUTOPOST_PLAN.md` §6
- [ ] Add `is_lab_user boolean default false` to `profiles`
- [ ] Create `app_settings` table with seeded rows for global + per-platform flags
- [ ] Set `app_settings.autopost_enabled = false` initially (master kill switch defaults off)
- [ ] Add indexes: `autopost_schedules(next_fire_at) where active = true`, `autopost_publish_jobs(status, scheduled_for)`, `autopost_runs(schedule_id, fired_at desc)`
- [ ] Run migration against staging Supabase first (if staging exists, otherwise direct to prod with backup)

### 1.2 Token encryption
- [ ] Verify `pgsodium` extension is enabled in Supabase project (Database → Extensions)
- [ ] Set up column-level encryption on `autopost_social_accounts.access_token` and `.refresh_token`
- [ ] Test round-trip: insert encrypted token via service_role, read back via service_role, confirm plaintext returned matches

### 1.3 RLS policies (admin-only at this stage)
- [ ] Enable RLS on all four `autopost_*` tables
- [ ] Write policy: "lab users own their social accounts" on `autopost_social_accounts`
- [ ] Write policy: "lab users own their schedules" on `autopost_schedules`
- [ ] Write policy: "lab users see runs of their schedules" on `autopost_runs` (joined through `schedule_id`)
- [ ] Write policy: "lab users see publish jobs of their runs" on `autopost_publish_jobs` (joined through `run_id` → `schedule_id`)
- [ ] Verify with a non-admin test user: cannot select, insert, update, or delete any row

### 1.4 Flip Jo to lab user
- [ ] `update profiles set is_lab_user = true where email in ('arcanadraconi@gmail.com', 'josinsidevoice@gmail.com');`
- [ ] Verify Jo's session can now select from `autopost_*` tables (will be empty, but no permission error)

### 1.5 Type generation
- [ ] Regenerate Supabase TypeScript types: `npx supabase gen types typescript --project-id ayjbvcikuwknqdrpsdmj > src/types/database.ts`
- [ ] Confirm new `autopost_*` types appear

### Phase 1 Definition of Done
Migrations applied. Jo flipped. RLS verified blocking non-admins. Token encryption tested. No app code touched yet.

---

## Phase 2 — Admin Gate + `/lab` Route Shell (Week 1, Days 4–5)

Pure routing. No autopost logic yet.

### 2.1 AdminOnlyRoute component
- [ ] Create `src/components/auth/AdminOnlyRoute.tsx`
- [ ] Reads `is_lab_user` from current session's profile (use existing profile hook)
- [ ] Redirects to `/app` if `false` or null
- [ ] Renders children if `true`
- [ ] Shows loading state while profile hydrates (prevents flicker)

### 2.2 Routes mounted in `src/App.tsx`
- [ ] Import `AdminOnlyRoute`
- [ ] Add `/lab` → admin landing page (lists experiments)
- [ ] Add `/lab/autopost` → autopost landing
- [ ] Add `/lab/autopost/connect` → connect platforms page
- [ ] Add `/lab/autopost/schedules` → list
- [ ] Add `/lab/autopost/schedules/new` → wizard
- [ ] Add `/lab/autopost/schedules/:id` → edit
- [ ] Add `/lab/autopost/runs` → history
- [ ] Add `/lab/autopost/runs/:id` → run detail
- [ ] All routes wrapped in `<AdminOnlyRoute>`
- [ ] All routes ordered AFTER existing routes in the JSX (additive)

### 2.3 Page scaffolds
- [ ] `src/pages/lab/LabHome.tsx` — placeholder listing "Autopost" experiment card
- [ ] `src/pages/lab/autopost/AutopostHome.tsx` — placeholder dashboard
- [ ] `src/pages/lab/autopost/Connect.tsx` — placeholder
- [ ] `src/pages/lab/autopost/SchedulesList.tsx` — placeholder
- [ ] `src/pages/lab/autopost/ScheduleWizard.tsx` — placeholder
- [ ] `src/pages/lab/autopost/ScheduleEdit.tsx` — placeholder
- [ ] `src/pages/lab/autopost/RunHistory.tsx` — placeholder
- [ ] `src/pages/lab/autopost/RunDetail.tsx` — placeholder

### 2.4 Verification
- [ ] Logged in as Jo: `/lab` loads
- [ ] Logged in as Jo: navigation between `/lab/autopost/*` works
- [ ] Logged in as a non-admin test user: `/lab` redirects to `/app`
- [ ] Logged out: `/lab` redirects to `/auth`
- [ ] No sidebar/main-nav links to `/lab` exist anywhere — pure URL access

### Phase 2 Definition of Done
Jo can hit `/lab/autopost`. Anyone else gets bounced. No existing routes changed shape.

---

## Phase 3 — YouTube OAuth (Week 2, Days 1–2)

First platform connection. Sets the OAuth pattern for IG + TikTok.

### 3.1 Google Cloud project setup
- [ ] Confirm existing Google Cloud project (the one that hosts the OAuth consent screen branded "motionmax")
- [ ] Enable **YouTube Data API v3** in that project
- [ ] Add scope `https://www.googleapis.com/auth/youtube.upload` to OAuth consent screen
- [ ] Add `https://app.motionmax.io/api/autopost/connect/youtube/callback` to authorized redirect URIs
- [ ] **File quota increase request** (Google Cloud Console → IAM & Admin → Quotas → search "YouTube Data API v3 queries per day")
  - [ ] Request bump from 10,000 to 1,000,000 units/day (~600 uploads/day)
  - [ ] Justification: "Scheduled video generation tool, users connect their own channels via OAuth, expected 10–50 active users in first 90 days"
  - [ ] Note: approval typically 1–2 weeks

### 3.2 Vercel Function: connect start
- [ ] Create `api/autopost/connect/youtube/start.ts`
- [ ] Generates state token, stores in short-lived cookie (or signed JWT)
- [ ] Returns redirect to Google authorization URL with scope, redirect_uri, access_type=offline, prompt=consent (force refresh token issuance)

### 3.3 Vercel Function: callback
- [ ] Create `api/autopost/connect/youtube/callback.ts`
- [ ] Validates state token from cookie
- [ ] Exchanges code for tokens via `oauth2.googleapis.com/token`
- [ ] Calls `youtube.channels.list?part=snippet,id&mine=true` to get channel ID + display name + avatar
- [ ] Inserts/upserts `autopost_social_accounts` row with encrypted tokens (use service_role key)
- [ ] Redirects user back to `/lab/autopost/connect?platform=youtube&status=connected`

### 3.4 Connect UI
- [ ] `src/pages/lab/autopost/Connect.tsx`: card per platform
- [ ] YouTube card: shows existing connected channels (display_name + avatar) or "Connect YouTube" button
- [ ] "Connect" button → `window.location = '/api/autopost/connect/youtube/start'`
- [ ] "Disconnect" button → DELETE `/api/autopost/accounts/:id` → reload

### 3.5 Verification
- [ ] Jo connects own YouTube channel from `/lab/autopost/connect`
- [ ] Row appears in `autopost_social_accounts` with status='connected'
- [ ] Tokens are encrypted in DB (verify via direct SQL, not via API)
- [ ] Disconnect removes the row and revokes the token at Google (`oauth2.googleapis.com/revoke`)

### Phase 3 Definition of Done
Jo's YouTube channel connected. Quota increase application filed. Pattern established for next two platforms.

---

## Phase 4 — Instagram OAuth + Meta App Review submission (Week 2, Days 3–4)

### 4.1 Meta app setup
- [ ] Confirm existing Meta app or create new "MotionMax Autopost" Meta app
- [ ] Add product: **Instagram Graph API** (not legacy Instagram Basic Display)
- [ ] Configure permissions to request:
  - [ ] `instagram_business_basic`
  - [ ] `instagram_business_content_publish`
  - [ ] `pages_show_list` (needed to discover linked FB Page)
- [ ] Add OAuth redirect URI: `https://app.motionmax.io/api/autopost/connect/instagram/callback`
- [ ] Add app domain: `motionmax.io`

### 4.2 Vercel Functions (same shape as YouTube)
- [ ] Create `api/autopost/connect/instagram/start.ts`
- [ ] Create `api/autopost/connect/instagram/callback.ts`
- [ ] Callback exchanges code → user token → page tokens → IG Business account ID via `/me/accounts` then `/{page-id}?fields=instagram_business_account`
- [ ] Stores `platform_account_id` = IG Business account ID
- [ ] Stores tokens encrypted

### 4.3 Connect UI
- [ ] Instagram card on `/lab/autopost/connect` mirrors YouTube card
- [ ] Pre-flight check: if user's IG account is "Creator" not "Business", show inline guidance to convert before connecting

### 4.4 Meta App Review submission
- [ ] Record screencast video showing:
  - [ ] User logs into MotionMax
  - [ ] Navigates to autopost connect screen
  - [ ] Clicks "Connect Instagram"
  - [ ] Meta consent screen appears
  - [ ] Permissions granted
  - [ ] Returns to MotionMax with account connected
  - [ ] Creates a schedule that targets the IG account
  - [ ] Schedule fires, video generates, posts to IG, post URL appears in run history
- [ ] Write data use justifications for both permissions (must be specific, not generic)
- [ ] Submit for App Review (Settings → App Review → Permissions and Features)
- [ ] **Note review status as `[!] pending` in this checklist until approved (1–4 weeks typical)**

### 4.5 Verification (sandbox / app-review test users)
- [ ] Add Jo's IG account as a Test User in Meta app
- [ ] Test the full connect flow with the test user (works without review approval)
- [ ] Confirm row in `autopost_social_accounts` with platform='instagram'

### Phase 4 Definition of Done
IG OAuth flow works for test users. App Review submitted. Will unblock Phase 9 publishing once approved.

---

## Phase 5 — TikTok OAuth + Audit submission (Week 2, Day 5)

### 5.1 TikTok developer app setup
- [ ] Create app at developers.tiktok.com (or use existing)
- [ ] Enable **Login Kit** + **Content Posting API**
- [ ] Request scopes: `user.info.basic`, `video.publish`, `video.upload`
- [ ] Add redirect URI: `https://app.motionmax.io/api/autopost/connect/tiktok/callback`
- [ ] Configure terms of service URL: `https://motionmax.io/legal/terms`
- [ ] Configure privacy policy URL: `https://motionmax.io/legal/privacy`

### 5.2 Vercel Functions
- [ ] Create `api/autopost/connect/tiktok/start.ts`
- [ ] Create `api/autopost/connect/tiktok/callback.ts`
- [ ] Callback exchanges code → access_token + open_id via `/v2/oauth/token/`
- [ ] Calls `/v2/user/info/` to get display_name + avatar_url
- [ ] Stores tokens encrypted, `platform_account_id` = `open_id`

### 5.3 Connect UI
- [ ] TikTok card on `/lab/autopost/connect`
- [ ] Disclosure note: "Until TikTok approves our publishing audit, posts will be uploaded as private drafts to your account."

### 5.4 TikTok audit submission
- [ ] In TikTok developer portal: Apps → MotionMax → Audit
- [ ] Provide:
  - [ ] App description (clear: scheduled video generation, user owns and approves all content)
  - [ ] Screencast demo (same content as Meta App Review screencast, focused on TikTok flow)
  - [ ] Daily active creator estimate (start small: "≤50 in first 90 days")
  - [ ] Daily post estimate per creator (3–5)
  - [ ] Confirmation that AI-content disclosure flag is set on every post
  - [ ] Confirmation that no third-party watermarks/branding are added by our app
- [ ] Submit (5–10 business days typical)
- [ ] **Note status as `[!] pending` until approved**

### 5.5 Verification (sandbox)
- [ ] Connect Jo's TikTok account
- [ ] Confirm row in `autopost_social_accounts` with platform='tiktok'
- [ ] Sandbox: posts will publish privately even after Phase 10 lands, until audit clears

### Phase 5 Definition of Done
TikTok OAuth works for Jo. Audit submitted. All three review applications now in flight in parallel.

---

## Phase 6 — Schedule Tick + Run Wiring (Week 3, Days 1–3)

The Postgres-side machinery that makes schedules fire and create runs. No external publishing yet.

### 6.1 Enable extensions
- [ ] Verify `pg_cron` enabled (Database → Extensions in Supabase Dashboard)
- [ ] Verify `pg_net` enabled (used for outbound HTTP from Postgres if ever needed; nice-to-have)

### 6.2 Postgres functions
- [ ] Write `autopost_tick()` function:
  - [ ] Selects active schedules where `next_fire_at <= now()`
  - [ ] For each: computes next fire from `cron_expression` + `timezone` (use `cron.schedule_in_database()` helper or implement cron parsing in plpgsql)
  - [ ] Updates `next_fire_at`
  - [ ] Inserts row in `autopost_runs` with status='queued', resolved topic from pool, resolved prompt
  - [ ] Calls `pg_notify('autopost_run_created', run.id::text)`
- [ ] Schedule via cron: `select cron.schedule('autopost-tick', '* * * * *', $$select autopost_tick();$$);`
- [ ] Verify cron job appears in Database → Cron Jobs in dashboard

### 6.3 Trigger: render-completed → publish-jobs-created
- [ ] Write trigger function `on_video_job_completed_for_autopost()`:
  - [ ] AFTER UPDATE on `video_generation_jobs`
  - [ ] WHEN: status changed to 'completed' AND metadata->>'autopost_run_id' is not null
  - [ ] Updates `autopost_runs.status = 'rendered'`
  - [ ] For each `target_account_id` in the schedule, inserts an `autopost_publish_jobs` row
  - [ ] Calls `pg_notify('autopost_publish', publish_job.id::text)` for each
- [ ] Attach trigger to `video_generation_jobs`

### 6.4 Topic rotation logic
- [ ] Decide algorithm: round-robin based on `(autopost_runs count for schedule) % len(topic_pool)` (deterministic) or random (more variety)
- [ ] Implement inside `autopost_tick()` topic resolution

### 6.5 Manual fire endpoint (testing aid)
- [ ] Vercel Function `/api/autopost/schedules/:id/fire` (POST, admin-only)
- [ ] Inserts a run as if cron had fired, for testing without waiting for schedule time

### 6.6 Verification (no real publishing yet)
- [ ] Insert a test schedule via SQL with a 30s-from-now cron
- [ ] Wait 1 minute
- [ ] Confirm a row appeared in `autopost_runs` with status='queued'
- [ ] Confirm a `video_generation_jobs` row was inserted with the autopost_run_id metadata
- [ ] Wait for render to complete
- [ ] Confirm `autopost_runs.status` flipped to 'rendered'
- [ ] Confirm `autopost_publish_jobs` rows created (one per target account)
- [ ] Confirm `pg_notify` events visible if you `LISTEN` from a psql client

### Phase 6 Definition of Done
End-to-end scheduling works at the database level: tick fires, video gets generated, publish jobs get created, notifications emitted. No external API calls yet.

---

## Phase 7 — Worker Handler Scaffold + Retry Policy (Week 3, Days 4–5)

The Node-side listener that consumes notifications and will dispatch to per-platform handlers.

### 7.1 Worker process additions
- [ ] Create `worker/src/handlers/autopost/` directory
- [ ] Create `worker/src/handlers/autopost/index.ts` — registers LISTEN connections
- [ ] Add long-lived `pg` client connection in worker startup
- [ ] On startup: `LISTEN autopost_run_created` + `LISTEN autopost_publish` + `LISTEN autopost_publish_failed`
- [ ] On notification: dispatch to handler functions

### 7.2 Run handler (autopost_run_created → enqueue render)
- [ ] Worker receives notification with run.id
- [ ] Looks up run, schedule, and resolves prompt
- [ ] Inserts `video_generation_jobs` row tagged with `metadata.autopost_run_id`
- [ ] Updates `autopost_runs.status = 'generating'`

### 7.3 Publish dispatcher (autopost_publish → platform handler)
- [ ] Worker receives notification with publish_job.id
- [ ] Reads job, account, run, schedule
- [ ] Loads + decrypts tokens
- [ ] Dispatches to platform handler (stub for now): `youtube.publish()`, `instagram.publish()`, `tiktok.publish()`
- [ ] Stub handlers just log + mark `published` after 2s delay (so we can test fan-out without real APIs)

### 7.4 Shared retry policy
- [ ] Create `worker/src/handlers/autopost/retryPolicy.ts`
- [ ] Implements: attempt 1 immediate, attempt 2 after 60s, attempt 3 after 5 min
- [ ] Uses a simple sleep + retry loop (worker is long-running, no need for external scheduler)
- [ ] After 3 failures: `update autopost_publish_jobs set status='failed', error_code, error_message`, `pg_notify('autopost_publish_failed')`
- [ ] Token-expired errors: short-circuit retry → call `refreshTokenIfNeeded()` → immediate retry once

### 7.5 Token refresh worker
- [ ] Create `worker/src/handlers/autopost/tokenRefresh.ts`
- [ ] Runs every 5 minutes (in-process timer, not pg_cron — worker manages its own timers)
- [ ] Selects accounts where `token_expires_at < now() + interval '20 minutes'` (refresh at 80% of expiry)
- [ ] Per platform: calls refresh endpoint, updates encrypted tokens + `token_expires_at`
- [ ] On refresh failure: marks account `status='expired'`, surfaces in UI

### 7.6 Connection resilience
- [ ] If pg LISTEN connection drops: reconnect with exponential backoff
- [ ] On reconnect: query for any `autopost_publish_jobs` in 'pending' or 'uploading' status with `last_attempt_at` older than 5 min and re-enqueue (recovers from missed notifications)
- [ ] Log reconnection events to existing worker logger

### 7.7 Verification (with stub handlers)
- [ ] Manually fire a schedule via `/api/autopost/schedules/:id/fire`
- [ ] Watch worker logs: notification received, render enqueued, render completes, publish jobs created, stub handlers called, all marked 'published'
- [ ] Verify run status progresses: queued → generating → rendered → publishing → completed
- [ ] Kill worker mid-run: verify on restart, in-flight jobs are picked back up

### Phase 7 Definition of Done
Worker consumes notifications, runs the full pipeline end-to-end with stub publishers, retry policy works, token refresh runs. No real platform APIs called yet.

---

## Phase 8 — YouTube Real Publish Handler (Week 4, Days 1–2)

Replace the stub with real resumable uploads.

### 8.1 YouTube SDK or direct HTTP
- [ ] Decide: `googleapis` npm package vs raw HTTP. Recommend `googleapis` for OAuth helpers.
- [ ] Add to `worker/package.json`

### 8.2 Resumable upload implementation
- [ ] Create `worker/src/handlers/autopost/youtube.ts`
- [ ] `publish(job, account, video)`:
  - [ ] Set credentials from decrypted token
  - [ ] Initiate resumable session: `POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`
  - [ ] Snippet: title (from caption template, max 100 chars), description (caption + hashtags), tags
  - [ ] Status: `privacyStatus='public'`, `containsSyntheticMedia=true`, `selfDeclaredMadeForKids=false`
  - [ ] Stream MP4 from local render path or signed Supabase Storage URL in 8MB chunks
  - [ ] On success: `platform_post_id = videoId`, `platform_post_url = https://youtube.com/shorts/<id>`
- [ ] Handle 401 → trigger refresh + retry once
- [ ] Handle 403 quotaExceeded → mark job 'failed' with clear error, alert Jo, do not retry until next day

### 8.3 Shorts optimization
- [ ] If video duration ≤60s and aspect ratio 9:16, append `#Shorts` to description for the Shorts shelf
- [ ] If duration >60s but vertical, log warning (not Shorts-eligible) but still publish as regular video

### 8.4 Quota tracking
- [ ] Track upload count in `app_settings.youtube_quota_used_today` (jsonb with daily reset)
- [ ] Reset at midnight Pacific (when Google's quota resets)
- [ ] If quota would exceed: defer remaining publishes to tomorrow with status='pending', `scheduled_for=tomorrow 00:01 PT`

### 8.5 Verification
- [ ] Run a real schedule fire that publishes to Jo's YouTube channel
- [ ] Verify video appears on channel
- [ ] Verify `platform_post_url` is correct + clickable
- [ ] Verify `containsSyntheticMedia` flag is set (check via `videos.list?part=status`)
- [ ] Test failure: revoke token at Google → confirm refresh + retry → if refresh fails, account marked expired

### Phase 8 Definition of Done
Real videos publish to Jo's YouTube channel via the autopost pipeline. Quota tracking works.

---

## Phase 9 — Instagram Real Publish Handler (Week 4, Days 3–4)

Blocked on Meta App Review approval. If approval pending: build against test users; ship handler ready to flip to production.

### 9.1 Public video URL hosting
- [ ] Decide: serve from Supabase Storage with signed URL or from Vercel CDN
- [ ] Recommend: Supabase Storage public bucket `autopost-publish-temp` with signed URLs valid for 1 hour
- [ ] After publish confirmed, delete object (saves storage cost and prevents indefinite public exposure)

### 9.2 Two-step publish
- [ ] Create `worker/src/handlers/autopost/instagram.ts`
- [ ] Step 1: `POST https://graph.facebook.com/v19.0/{ig-user-id}/media`
  - [ ] `media_type=REELS`
  - [ ] `video_url=<signed url>`
  - [ ] `caption=<resolved caption + hashtags>`
  - [ ] `share_to_feed=true` (also shows in main grid)
- [ ] Step 2: poll `GET /{container-id}?fields=status_code` every 5s
  - [ ] Status `IN_PROGRESS` → keep polling (max 5 min)
  - [ ] Status `FINISHED` → proceed
  - [ ] Status `ERROR` → fail with error message
- [ ] Step 3: `POST /{ig-user-id}/media_publish?creation_id=<container-id>`
- [ ] On success: `platform_post_id = media id`, `platform_post_url = https://instagram.com/p/<shortcode>`

### 9.3 Constraints enforcement (pre-upload validation)
- [ ] Reject if duration > 90s (mark job failed with clear message)
- [ ] Reject if file > 100MB
- [ ] Reject if aspect ratio not 9:16
- [ ] Reject if framerate > 30fps
- [ ] These checks run BEFORE attempting upload to save Meta API calls

### 9.4 Cleanup
- [ ] After successful publish, delete the temp signed-URL object
- [ ] On failure after all retries, also delete (don't leak public URLs)

### 9.5 Verification (test users until App Review approves)
- [ ] Run schedule fire targeting Jo's IG Business account (must be Test User on Meta app)
- [ ] Verify reel appears on IG
- [ ] Verify FB Page cross-post if linked
- [ ] When App Review approves: re-test with non-test-user account, confirm same behavior

### Phase 9 Definition of Done
Reels publish end-to-end on Jo's IG Business account. Handler ready to serve all approved users once App Review clears.

---

## Phase 10 — TikTok Real Publish Handler (Week 4, Day 5)

Until audit approved: posts upload as private drafts. After audit: posts publish public.

### 10.1 Direct Post implementation
- [ ] Create `worker/src/handlers/autopost/tiktok.ts`
- [ ] `POST /v2/post/publish/video/init/`
  - [ ] `post_info`: title, privacy_level (`PUBLIC_TO_EVERYONE` if audited else `SELF_ONLY`)
  - [ ] `post_info.disable_duet`, `disable_stitch`, `disable_comment` from schedule config (defaults all false)
  - [ ] `post_info.video_cover_timestamp_ms`: pick midpoint of video
  - [ ] `post_info.brand_content_toggle = false` (these are creator originals, not brand promos)
  - [ ] `post_info.is_aigc = true` (AI-generated content disclosure)
  - [ ] `source_info.source = FILE_UPLOAD`, `video_size`, `chunk_size`, `total_chunk_count`
- [ ] Receive upload_url + publish_id
- [ ] Upload chunks to upload_url with `Content-Range` headers
- [ ] Poll `POST /v2/post/publish/status/fetch/` until status `PUBLISH_COMPLETE` or `FAILED`
- [ ] On success: `platform_post_id = publish_id`, `platform_post_url = https://www.tiktok.com/@<username>/video/<publish_id>`

### 10.2 Audit-pending posture
- [ ] Read `app_settings.tiktok_audit_status` ('pending' | 'approved' | 'rejected')
- [ ] If 'pending' or 'rejected': force `privacy_level = SELF_ONLY` and surface this in run history ("Posted privately because audit is pending")
- [ ] If 'approved': use schedule's configured visibility

### 10.3 Per-creator daily cap awareness
- [ ] Before publish: count today's `autopost_publish_jobs` with status='published' for this `social_account_id`
- [ ] If ≥ 15: defer with `scheduled_for = tomorrow`
- [ ] Surface "TikTok daily cap reached, deferred to tomorrow" in run history

### 10.4 Verification
- [ ] Run schedule fire targeting Jo's TikTok
- [ ] Verify private upload appears in Jo's TikTok drafts/private posts
- [ ] When audit approved: flip `app_settings.tiktok_audit_status = 'approved'`, run again, verify public post

### Phase 10 Definition of Done
TikTok publish handler ships in private-drafts mode. Public mode unblocks the day audit clears.

---

## Phase 11 — Schedule Wizard + Run History UI (Week 5, full week)

The polished web UI Jo will actually use day-to-day.

### 11.1 Schedule wizard (`/lab/autopost/schedules/new`)
- [ ] Step 1 — What to make
  - [ ] Prompt template field (multiline, with template variable hints)
  - [ ] Topic pool (textarea, one per line)
  - [ ] Motion preset dropdown (mirrors `Inspector.tsx` presets) + "Random from curated set" option
  - [ ] Duration slider (5–90s)
  - [ ] Resolution selector (1080×1920 default, 1920×1080 alternative)
- [ ] Step 2 — When
  - [ ] Cron presets: "Daily", "M/W/F", "Weekdays", "Weekends", "Custom"
  - [ ] Custom cron field with humanizer below ("Mon, Wed, Fri at 9:00 AM ET")
  - [ ] Timezone dropdown (default America/New_York)
  - [ ] Show next 5 fire times preview
- [ ] Step 3 — Where
  - [ ] Connected accounts list grouped by platform
  - [ ] Checkbox per account
  - [ ] Caption template per platform (different fields, different max lengths)
  - [ ] Hashtags input (chip-style, comma or space separated)
  - [ ] AI disclosure toggle (always on, disabled, with tooltip "Required for compliance")
- [ ] Step 4 — Review + Test
  - [ ] Summary of all choices
  - [ ] "Generate test video now" button → fires once, creates run with publish_jobs in 'pending' status (manual approval required to actually publish)
  - [ ] "Save & Activate" button → creates schedule active=true
  - [ ] "Save as Draft" button → active=false

### 11.2 Schedule list (`/lab/autopost/schedules`)
- [ ] Table columns: Name, Cadence (humanized), Platforms (icon stack), Active toggle, Next fire, Last fire, Actions (edit, duplicate, delete)
- [ ] "New schedule" button top-right
- [ ] Empty state with CTA

### 11.3 Schedule edit (`/lab/autopost/schedules/:id`)
- [ ] Same form as wizard but pre-populated
- [ ] Changing cron immediately recalculates `next_fire_at`
- [ ] Save button + Cancel button

### 11.4 Run history (`/lab/autopost/runs`)
- [ ] Reverse-chronological list grouped by date
- [ ] Each row: thumbnail, schedule name, fired_at, status pill, per-platform pills (icon + status color)
- [ ] Click row → `/lab/autopost/runs/:id`
- [ ] Filter dropdown: status, schedule, platform, date range

### 11.5 Run detail (`/lab/autopost/runs/:id`)
- [ ] Top: thumbnail (from rendered MP4), full prompt, generation log
- [ ] Per-platform timeline: queued → uploading → processing → published (with timestamps)
- [ ] Live links to published posts where applicable
- [ ] Errors expanded if any
- [ ] "Retry" button on failed jobs (re-enqueues with attempts=0)
- [ ] "Approve & Publish" button if test run is awaiting manual approval

### 11.6 Thumbnail generation
- [ ] When `autopost_runs.status = 'rendered'`, worker generates a 360×640 jpeg from frame at duration/2
- [ ] Stores in Supabase Storage `autopost-thumbnails` bucket
- [ ] Public URL stored in `autopost_runs.thumbnail_url` (add column in migration if not present)

### 11.7 Live updates via realtime
- [ ] Subscribe to `autopost:user=<id>` channel on schedule list + run history pages
- [ ] On `schedule_fired` event: prepend new run row
- [ ] On `publish_started/succeeded/failed`: update pill colors + status text inline
- [ ] No page refresh required

### Phase 11 Definition of Done
Jo can create, edit, activate schedules + watch runs in real-time + dig into run details from the polished UI.

---

## Phase 12 — Soft Launch Hardening (Week 6)

Polish, observability, kill-switch testing, before opening to anyone other than Jo.

### 12.1 Observability
- [ ] Worker logs: structured JSON, includes run_id + publish_job_id + platform on every line
- [ ] Add per-platform success/failure counters (Prometheus-style if existing infra supports, else simple table)
- [ ] Daily summary email to Jo: runs fired, runs succeeded, runs failed, breakdown by platform

### 12.2 Kill switch drills
- [ ] Set `app_settings.autopost_enabled = false` → confirm worker stops processing
- [ ] Set `autopost_youtube_enabled = false` → confirm only YouTube paused, other platforms continue
- [ ] Restore both, verify resumes from where it left off

### 12.3 Edge case tests
- [ ] Schedule with non-existent target account ID → graceful error in run detail
- [ ] Schedule fires while worker is down → worker boots, picks up backlog, processes in order
- [ ] Render takes longer than 1 hour → verify no timeout, status stays 'generating'
- [ ] Token revoked at provider while job is uploading → fails cleanly, account marked expired
- [ ] Publish hits provider rate limit (HTTP 429) → exponential backoff respects `Retry-After`

### 12.4 Documentation
- [ ] Add a section to `AUTOPOST_PLAN.md` §10 marking which phases are complete
- [ ] Note any deviations from the plan with explanation
- [ ] Capture lessons learned (e.g., "TikTok audit was actually 14 days, not 5–10")

### Phase 12 Definition of Done
Soft launch is operationally clean for Jo. Worker, observability, kill switches, edge cases all verified.

---

## Phase 13 — Graduation to Studio Plan (Week 7+, depends on review approvals)

Open up to paying users.

### 13.1 RLS policy update
- [ ] Alter all `autopost_*` policies from `is_lab_user = true` to `plan_name in ('studio', 'enterprise', 'studio_pro') AND profiles.autopost_enabled = true`
- [ ] Add `autopost_enabled boolean default false` column on `profiles`
- [ ] Default false: users opt in via UI

### 13.2 Pricing tier rollout
- [ ] Add Stripe product: "Studio Pro" at $199/mo (per `AUTOPOST_PLAN.md` §13)
- [ ] Update `src/lib/planLimits.ts` with `studio_pro` tier
- [ ] Update `Usage.tsx` to surface autopost limits per plan

### 13.3 Route graduation
- [ ] Move pages from `src/pages/lab/autopost/` to `src/pages/autopost/`
- [ ] Mount `/autopost/*` routes in `src/App.tsx` (still gated, now by plan + opt-in)
- [ ] Add sidebar entry "Autopost" visible only to eligible users
- [ ] Keep `/lab/*` for future experiments (do not delete)

### 13.4 Marketing
- [ ] Marketing site landing section explaining autopost
- [ ] Demo video (made with autopost itself, very meta)
- [ ] Update pricing page

### Phase 13 Definition of Done
Studio Pro tier live, autopost generally available to paying users, marketing landed.

---

## Phase 14 — Mobile Parity (iOS, then Android)

Tracks alongside `NATIVE_MOBILE_PLAN.md`. Starts only when iOS editor shell exists.

### 14.1 iOS — `MMAutopost` package
- [ ] Scaffold SPM package under `ios/Packages/MMAutopost/`
- [ ] Implement Connect screen (SwiftUI)
- [ ] Implement OAuth flow via `ASWebAuthenticationSession` for all three platforms
- [ ] Implement schedule list (read-only first)
- [ ] Implement schedule wizard (mirrors web)
- [ ] Implement run history with thumbnails
- [ ] Subscribe to Supabase realtime channel for live updates
- [ ] APNs push registration for `publish_succeeded` / `publish_failed`

### 14.2 Android — `core-autopost` module
- [ ] Scaffold module under `android/core/core-autopost/`
- [ ] Mirror iOS module in Compose
- [ ] OAuth via Custom Tabs
- [ ] FCM push registration

### 14.3 Backend additions for push
- [ ] Add `device_tokens` table (user_id, platform, token, registered_at)
- [ ] Worker sends push via APNs/FCM after `pg_notify('autopost_publish_succeeded')` and `_failed`

### Phase 14 Definition of Done
iOS and Android users get full autopost parity. Same REST endpoints. Same realtime events. Same UI semantics. Live in App Store + Play Store after their respective NATIVE_MOBILE_PLAN milestones land.

---

## Phase 15 — Future / Backlog (do not block launch)

Tracked for visibility, deliberately out of scope for v1.

- [ ] LinkedIn video API integration (enterprise tier, low priority)
- [ ] X (Twitter) video upload (paid API tier, $100/mo, defer until demand)
- [ ] YouTube long-form support (vs Shorts only) with playlists, end screens
- [ ] Cross-platform analytics dashboard (views, engagement) — needs read scopes per platform
- [ ] AI caption generation per platform (use Claude to optimize for each platform's voice)
- [ ] A/B test variants per schedule (post 2 thumbnails, pick winner)
- [ ] Team/agency mode (one user manages multiple accounts they don't own — needs separate compliance review)
- [ ] Webhook ingress for content moderation actions (Meta sends takedown notices via webhook)
- [ ] Bulk import schedules (CSV) for power users
- [ ] Schedule templates library (community-shared cron + prompt sets)

---

## Master Timeline at a Glance

| Week | Phase(s) | Outcome |
|---|---|---|
| **1** | 1, 2 | Schema + admin gate. Jo lands on `/lab/autopost`. |
| **2** | 3, 4, 5 | All 3 OAuth flows work. All 3 review applications filed. |
| **3** | 6, 7 | Tick + worker pipeline runs end-to-end with stub publishers. |
| **4** | 8, 9, 10 | Real publishers shipped (IG/TikTok in test/private until reviews approve). |
| **5** | 11 | Wizard, history, thumbnails, realtime UI. |
| **6** | 12 | Hardening, kill switches, observability. **Soft launch complete.** |
| **7+** | 13 | Reviews approved → graduate to Studio Pro plan → general availability. |
| **8+ (parallel mobile track)** | 14 | iOS, then Android, ship autopost UI per `NATIVE_MOBILE_PLAN.md`. |

---

## Resumption Instructions for Future-You / Future-AI

If you walk into this cold:

1. Read `AUTOPOST_PLAN.md` first (architecture), then this checklist (status).
2. `git log --oneline | head -50` to see what's been committed since the doc was written.
3. Check this checklist: which phase has the most boxes ticked? That's where work is happening.
4. Check Supabase Dashboard:
   - Database → Migrations → which `autopost_*` migrations have run?
   - Database → Cron Jobs → is `autopost-tick` registered?
   - Auth → Settings → are OAuth redirect URIs configured?
5. Check three review queues:
   - YouTube quota: Google Cloud Console → IAM & Admin → Quotas
   - Meta App Review: developers.facebook.com → MotionMax app → App Review
   - TikTok audit: developers.tiktok.com → MotionMax app → Audit
6. Check `app_settings` table values for the three kill switches
7. **Do not** move publish handlers from `worker/` into Supabase Edge Functions (see `AUTOPOST_PLAN.md` §3)
8. **Do not** link `/lab` from main nav until Phase 13 graduation
9. **Do not** disable AI-content disclosure flag — required for compliance on all three platforms

**Total realistic timeline from kickoff to GA:** 7–9 weeks for web + admin launch. 14–16 weeks for full mobile parity.

**End of checklist.** Tick boxes as you go. When all of Phase 12 is `[x]`, the soft launch is shippable to Jo. When Phase 13 is `[x]`, paying users can self-serve.
