# Jo's MotionMax TODO

When you have energy and patience for Google's bullshit, come back here.

---

## Manual things only Jo can do (mostly clicking, requires browser logins)

### SEO foundation — the "go to Google and click" stuff
- [ ] **Replace `public/og-image.png`** with a real product hero shot (currently bare logo on white — every share looks UNKNOWN)
  - Specs in `SEO_DISTRIBUTION_ROADMAP.md` §1.1
  - 1200×630, brand colors #0F1112 / #2D9A8C / gold gradient, headline "AI Video Generator — Turn Text Into Cinematic Videos"
  - Also create square 1080×1080, Twitter banner 1500×500, YouTube banner 2560×1440
- [ ] **Submit sitemap to Google Search Console** at https://search.google.com/search-console (domain already verified for OAuth)
  - Submit `https://motionmax.io/sitemap.xml`
  - Click "Request Indexing" on homepage + /pricing + /terms + /privacy + /acceptable-use
- [ ] **Set up Bing Webmaster Tools** at https://www.bing.com/webmasters (can import from Google Search Console)
- [ ] **Create Google Business Profile** at https://business.google.com (postcard verification takes 5–14 days)

### Social handles to claim/seed
- [ ] Verify Twitter @motionmaxio + try to claim @motionmaxai
- [ ] Create LinkedIn company page "MotionMax AI"
- [ ] Create YouTube channel @motionmaxai
- [ ] Create TikTok @motionmaxai
- [ ] Create Instagram @motionmaxai
- [ ] Reserve Threads (auto-linked to Instagram)
- [ ] Reserve Reddit u/motionmaxai
- [ ] Reserve Pinterest motionmaxai

### Directory submissions (afternoon of form-filling, do in batches)
Curated list with links in `SEO_DISTRIBUTION_ROADMAP.md` §1.7 + §2.1 + §2.3. Highlights:
- [ ] Futurepedia
- [ ] TheresAnAIForThat
- [ ] G2 (claim profile + request reviews from users)
- [ ] Capterra (gets you GetApp + Software Advice in one form)
- [ ] AlternativeTo (list as alt to Pictory, Synthesia, Runway, Lumen5, Pika, InVideo, Kapwing)
- [ ] Trustpilot (claim profile + request first 5 reviews)
- [ ] BetaList
- [ ] SaaSHub
- [ ] ProductHunt (DON'T launch yet — needs prep, see §5)

---

## Things to come back and implement together (waiting on Jo's energy)

### Admin enhancements (28 items, exists in repo)
- [ ] Work through `ADMIN_ENHANCEMENTS_BACKLOG.md` — 28 admin section enhancements from the prior Forge audit
- [ ] Highlights to do first:
  - [ ] Force sign out user (flips `auth.users.banned_until`)
  - [ ] CSV export on AdminSubscribers / AdminGenerations / AdminApiCalls
  - [ ] Cmd+K command palette inside admin
  - [ ] Bulk resolve flags in AdminFlags
  - [ ] Tail mode (auto-refresh every 5s) in AdminLogs
  - [ ] Per-row Cost breakdown tooltip in AdminApiCalls

### Autopost / Automation — soft-launch BUILT (2026-04-28)
- [x] Phase 1: schema + RLS (4 autopost_* tables + app_settings, admin-gated via is_admin())
- [x] Phase 2: AdminOnlyRoute + `/lab/autopost/*` route shell (8 pages)
- [x] Phase 3-5: OAuth Vercel Functions for YouTube, Instagram, TikTok (start + callback + disconnect + manual fire)
- [x] Phase 6: pg_cron tick + render-completed trigger (autopost_tick() runs every minute)
- [x] Phase 7: Worker dispatcher (5s poll, atomic claim, retry policy 0/60s/5min, token refresh every 5min)
- [x] Phase 8-10: Real publishers (YouTube Shorts, IG Reels, TikTok Direct Post) with stub escape hatch via AUTOPOST_STUB_PUBLISHERS=true
- [x] Phase 11: Wizard + List + Edit + Connect + RunHistory + RunDetail + Dashboard with kill switches, all responsive, all realtime
- [x] Phase 12: Hardening — per-platform metrics table, daily summary, kill-switch drills, 5 edge cases, run timeout cleanup
- [ ] **Jo: configure OAuth credentials in Vercel env** (see `AUTOPOST_ENV.md` — GOOGLE_OAUTH_*, META_APP_*, TIKTOK_CLIENT_*, OAUTH_STATE_SECRET)
- [ ] **Jo: submit Meta App Review + TikTok Audit** (after testing as admin for a week)
- [ ] **Jo: enable pgsodium column-level encryption via Supabase Vault** before Phase 13 graduation
- [ ] Phase 13: Graduate `/lab/autopost` → `/autopost` for Studio Pro plan (after week of testing)

### Native mobile (full plan written, 3–4 month build)
- [ ] Implement `NATIVE_MOBILE_PLAN.md` — Swift/SwiftUI iOS + Kotlin/Compose Android
- [ ] Stripe billing only (no StoreKit — see §3 of plan)
- [ ] Free Apple ID enough for first 6 weeks; $99 Apple Developer fee at week 6
- [ ] $25 Google Play Console fee at Android week 13
- [ ] Decisions still owed (per §8): Bundle ID confirmation, iPhone-only vs universal, min iOS version, min Android version

### SEO content + outreach (the longer-tail work)
- [ ] Write 10 launch blog posts (titles + targets in `SEO_DISTRIBUTION_PLAN.md` §7.3)
  - "How to Make a Cinematic AI Video From Text in Under 5 Minutes"
  - "MotionMax Review 2026: Honest Take After 100 Videos"
  - "Pictory vs MotionMax", "Synthesia vs MotionMax" comparison posts
  - "7 Best AI Video Generators in 2026" listicle
  - 5 more in roadmap §3.3 + §4.1
- [ ] Build Astro blog infrastructure at `/blog` (see roadmap §3.1)
- [ ] Programmatic SEO: 30 `/alternatives/[competitor]` pages + 10 `/use-cases/[case]` pages (see roadmap §6)
- [ ] ProductHunt launch (Phase 5 of roadmap — Tuesday-Thursday, needs prep + hunter + supporters)
- [ ] Hacker News "Show HN" post (Phase 8)
- [ ] Cold email batch to AI newsletters (Ben's Bites, Rundown AI, TLDR AI — template in plan §9.1)
- [ ] YouTube creator outreach (Matt Wolfe, MattVidPro AI, AI Andy — list in plan §9.2)

---

## Reference — docs at root of repo

- `360assess.md` / `360roadmap_fix.md` — production readiness audit
- `ADMIN_ENHANCEMENTS_BACKLOG.md` — 28 admin enhancements waiting
- `AUTOPOST_PLAN.md` + `AUTOPOST_ROADMAP.md` — scheduled gen + autopost
- `NATIVE_MOBILE_PLAN.md` — iOS + Android rewrite plan
- `SEO_DISTRIBUTION_PLAN.md` + `SEO_DISTRIBUTION_ROADMAP.md` — full SEO/distribution playbook
- `PRICING_PROPOSAL.md` — pricing thinking
- `DEPLOYMENT_SECURITY.md` / `DISASTER_RECOVERY.md` — ops docs

---

## Already done in this session (don't redo)

- [x] Removed "Continue with GitHub" button from Auth page (commit `c85df36`)
- [x] Wrote `NATIVE_MOBILE_PLAN.md`
- [x] Wrote `AUTOPOST_PLAN.md` + `AUTOPOST_ROADMAP.md`
- [x] Wrote `SEO_DISTRIBUTION_PLAN.md` + `SEO_DISTRIBUTION_ROADMAP.md`
- [x] Fixed OpenRouter UNKNOWN — `worker/src/services/openrouter.ts` now sends `HTTP-Referer` + `X-Title` headers
- [x] Updated `AUTOPOST_PLAN.md` to make clear "Postgres" means the existing Supabase DB, not a new install

---

**Order of operations when Jo is back:** SEO clicking work (1 afternoon) → admin backlog (1–2 weeks) → autopost (4–6 weeks) → mobile native (3–4 months). Or whichever, your house.
