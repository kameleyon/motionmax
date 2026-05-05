# MotionMax Admin — Production-Ready Rebuild Checklist

> **Scope.** Replace the existing 10-tab admin (`src/pages/Admin.tsx` + `src/components/admin/Admin*.tsx`) with the 15-tab control panel from the Claude Design handoff at `C:\tmp_design\motionmax\` (`MotionMax Admin.html` + 6 `upgrades/admin*.jsx` files), reusing the existing dashboard sidebar (`src/components/dashboard/Sidebar.tsx`) — **no new sidebar shell, no Brand Kits surface**.
>
> **Definition of done.** Every box in this document is ticked. At the end, the admin renders all 15 tabs with real data, every action writes an `admin_logs` row, every kill-switch is honored by the worker within 5 s, every backend table proposed has an RLS policy, and the responsive shell works on a 360 px mobile viewport.
>
> **Reference fragments** (do not delete; they back every decision below):
> - `.admin-checklist-fragments/01-chat1-intent.md` — design-system inheritance from the original build session
> - `.admin-checklist-fragments/02-design-inventory.md` — exhaustive component/control/state inventory of the 15-tab design
> - `.admin-checklist-fragments/03-current-state.md` — gap analysis of existing admin code
> - `.admin-checklist-fragments/04-backend-audit.md` — per-tab backend data audit + new infra spec

---

## Table of contents

- [Phase 0 — Foundations & shared infra](#phase-0--foundations--shared-infra)
- [Phase 1 — Shell, routing, sidebar integration](#phase-1--shell-routing-sidebar-integration)
- [Phase 2 — Backend infrastructure (cross-cutting)](#phase-2--backend-infrastructure-cross-cutting)
- [Phase 3 — Tab: Overview](#phase-3--tab-overview)
- [Phase 4 — Tab: Analytics](#phase-4--tab-analytics)
- [Phase 5 — Tab: Activity](#phase-5--tab-activity)
- [Phase 6 — Tab: API & Costs](#phase-6--tab-api--costs)
- [Phase 7 — Tab: API Keys](#phase-7--tab-api-keys)
- [Phase 8 — Tab: Users (+ drawer)](#phase-8--tab-users--drawer)
- [Phase 9 — Tab: Generations](#phase-9--tab-generations)
- [Phase 10 — Tab: Performance](#phase-10--tab-performance)
- [Phase 11 — Tab: Errors](#phase-11--tab-errors)
- [Phase 12 — Tab: Console](#phase-12--tab-console)
- [Phase 13 — Tab: Messages](#phase-13--tab-messages)
- [Phase 14 — Tab: Notifications](#phase-14--tab-notifications)
- [Phase 15 — Tab: Newsletter](#phase-15--tab-newsletter)
- [Phase 16 — Tab: Announcements](#phase-16--tab-announcements)
- [Phase 17 — Tab: Kill switches](#phase-17--tab-kill-switches)
- [Phase 18 — Quality gates (responsive, a11y, perf, observability)](#phase-18--quality-gates)
- [Phase 19 — Production verification](#phase-19--production-verification)

---

## Phase 0 — Foundations & shared infra ✅ COMPLETE (2026-05-05)

> Built and verified. 19 files / 1,352 lines added. `npx tsc --noEmit` exits 0.
> 12/12 unit tests pass (vitest). 0 `any` types in `_shared/`. 0 red colors in admin tokens.
> Cross-imports verified (Kpi/SearchRow/ActivityFeed all resolve `I` from `AdminIcons`).

### 0.1 Design tokens ✅
- [x] CSS variables added in NEW file `src/styles/admin-tokens.css`, scoped under `.admin-shell` so the admin theme can't leak elsewhere. Tokens: every value from the spec (`--bg`, `--panel`, `--panel-1/2/3`, ink ramp, line ramp, cyan family, gold family, `--good`, `--purple`, `--radius`, `--radius-lg`, font stacks). Plus `@keyframes adm-pulse` (2s) and `@keyframes adm-tab-pulse` (1.6s ring).
- [x] `--danger` aliased to gold (`#F5B049`) inside `.admin-shell` only — the rest of the app keeps its own `--danger`. `dashboard-shared.css` not touched.
- [x] Fonts confirmed: `Instrument Serif` (italic + upright) and `JetBrains Mono` added to `index.html` Google Fonts link (Inter already present). No `@fontsource` packages duplicated.
- [x] Zero red in admin tokens — `grep "#ff8a78\|#E85F4C\|rgba(232,95,76,"` in `admin-tokens.css` returns 0 matches.

### 0.2 Shared admin primitives ✅ — `src/components/admin/_shared/` (15 files)
- [x] `AdminIcons.tsx` (136 lines) — `I` object with 44 lucide-style inline SVGs (more than the 43 spec'd; covers every icon referenced across all 15 tabs). Each is a zero-arg component returning `<Svg>` with `currentColor`, 1.6 stroke, 14×14 viewBox 24. Plus `AdminIconName` type union.
- [x] `Sparkline.tsx` (58 lines) — defaults `w=90 h=30 color="var(--cyan)" fill=true`, polyline 1.4 stroke round-cap, optional 0.12-opacity area fill.
- [x] `BarChart.tsx` (73 lines) — flex bars `align-items:flex-end`, height `(v/max)*100%`, `min-height: 2px`, `transition: height .3s`, optional mono 9 labels.
- [x] `Donut.tsx` (97 lines) — CSS `conic-gradient` of slice angles, inner hole at `inset:size*0.18`, center renders serif total + mono uppercase label.
- [x] `Avatar.tsx` (70 lines) — `'sm'|'md'|'lg'` (extends spec with `'sm'` 22px), `linear-gradient(135deg, color, '#1a223f')`, initials = first letter of two name tokens.
- [x] `Kpi.tsx` (74 lines) — full prop surface (`label, value, unit?, delta?, deltaDir?, spark?, sparkColor?, icon?, tone?`), arrow resolved from `deltaDir` (up=good/`I.arrowUp`, down=warn/`I.arrowDown`, neutral=ink-mute), imports `Sparkline` for corner spark.
- [x] `Pill.tsx` (36 lines) — variants `cyan | purple | gold | ok | warn | err | danger | default` with optional leading dot.
- [x] `Toggle.tsx` (44 lines) — accessible `<label>` with hidden checkbox, knob translates 15px when `checked`, danger variant uses `--warn`.
- [x] `BarTrack.tsx` (48 lines) — `.bar-track > .bar-fill` with `transition:width .3s`, default cyan→cyan-2 gradient.
- [x] `SearchRow.tsx` (47 lines) — leading `I.search` icon, transparent input with mono placeholder, focus glows cyan.
- [x] `SectionHeader.tsx` (30 lines) — `.adm-sec-h` flex-end with serif h2 + right slot.
- [x] `ActivityFeed.tsx` (86 lines) — `.feed > .item` rows from `FeedItem[]` (id, tone, glyph, t, bodyText, metaTokens). Glyph lookup via `keyof typeof I`.
- [x] `AdminEmpty.tsx` (44 lines) — wraps existing `EmptyState` from `@/components/ui/empty-state`, admin-namespace prop names.
- [x] `AdminLoading.tsx` (12 lines) — pure named re-export of `AdminLoadingState` from `@/components/ui/admin-loading-state`.
- [x] `AdminTabBoundary.tsx` (96 lines) — class `<AdminTabBoundary tabKey={key}>{children}</AdminTabBoundary>`. Reports to `@sentry/react` with `tags: { tab: tabKey }`. State resets when `tabKey` changes so switching tabs clears the error automatically.

### 0.3 Data utilities ✅ — `src/components/admin/_shared/format.ts` (102 lines) + `format.test.ts` (72 lines, 12 tests)
- [x] `formatRel(d: Date | string): string` — `just now / Nm ago / Nh ago / Nd ago / Mon DD`.
- [x] `money(n: number): string` — 2-decimal en-US currency.
- [x] `money4(n: number): string` — 4-decimal en-US currency for API costs.
- [x] `num(n: number): string` — `toLocaleString('en-US')`.
- [x] `short(n: number): string` — `1.5M / 1.5k / N`.
- [x] `weekly(base, jitter?, len?)` — deterministic seed, JSDoc warns it's design-mock only.
- [x] **Verification:** `npx vitest run src/components/admin/_shared/format.test.ts` → 12/12 passed.

### 0.4 React Query conventions ✅ — `src/components/admin/_shared/queries.ts` (81 lines)
- [x] `ADMIN_QUERY_PREFIX = 'admin'`, `AdminTabKey` 15-tab union, `adminKey(tab, ...rest)` helper returning a `readonly` array.
- [x] `ADMIN_DEFAULT_QUERY_OPTIONS = { staleTime: 30_000, gcTime: 5*60_000, refetchOnWindowFocus: false }`. Per-tab overrides documented in JSDoc; tab files override locally (Console will use `staleTime: 0`).
- [x] Centralized — every future tab imports from this single source.
- [x] Legacy `["admin-…"]` keys NOT migrated yet — that's Phase 1+ work as planned.

### 0.5 Toast & confirmation conventions ✅ — `src/components/admin/_shared/confirmDestructive.tsx` (146 lines)
- [x] All admin code uses `sonner`'s `toast.success/error/info/warning`. Pattern matches existing `AdminUserDetails.tsx` and the rest of the app.
- [x] `<ConfirmDestructive>` wrapper with typed-confirm input — Confirm button stays disabled until user types the exact `confirmText` (target email, `DELETE`, etc.). Pending state blocks dismiss; reject leaves dialog open with toasted error message; resolve auto-closes with optional success toast.
- [x] `successMessage` prop accepts the audit-log row id pattern (`Granted 1,000 credits — admin_log #abcd1234`); each call site supplies its own format with the id from the RPC response.

---

## Phase 1 — Shell, routing, sidebar integration

### 1.1 Route + auth gate
- [ ] Keep existing `src/components/AdminRoute.tsx` and `src/hooks/useAdminAuth.ts` as the auth gate — they already handle loading state, redirect-with-returnUrl, and access-denied. No changes needed.
- [ ] Switch admin route to query-string driven tabs (`/admin?tab=overview`) per the existing `<a href="/admin">` sidebar entries. On mount, `Admin.tsx` reads `useSearchParams().get('tab')` and falls back to `'overview'`. `setTab` calls `navigate('/admin?tab=' + key, { replace: true })` so the sidebar deep-links work and the URL is shareable.
- [ ] Define the 15 tab keys as a TS const tuple: `['overview','analytics','activity','api','apikeys','users','gens','perf','errors','console','messages','notifs','news','announce','kill'] as const`. Export the type union.
- [ ] Validate the `?tab=` param against the union at runtime; unknown values fall back to `'overview'` with a `replace` redirect.

### 1.2 Sidebar integration (NO sidebar fork)
- [ ] Edit `src/components/dashboard/Sidebar.tsx` to add an Admin block **after the existing Studio block** (line ~330 area, after the closing `</div>` of the `mb-5` Studio section), gated by `{isAdmin && (...)}`.
- [ ] Mirror the existing nav pattern (anchor tags, `font-mono text-[10px] tracking-[0.16em] uppercase` h6 heading, `Sidebar.tsx`'s existing `.item` class).
- [ ] Single Admin section (NOT 15 sub-links) with a caret-collapsible sub-list. Initial collapsed/expanded state from `localStorage.mm_admin_sidebar_open`.
- [ ] Sub-items, in order matching the design's tab strip: `Overview, Analytics, Activity, API & Costs, API Keys, Users, Generations, Performance, Errors, Console, Messages, Notifications, Newsletter, Announcements, Kill switches`. Each `<a href="/admin?tab=<key>">`.
- [ ] Add active-state styling: when `pathname === '/admin' && currentSearchTab === key`, apply `bg-[#151B20] text-[#ECEAE4]` plus the cyan left rail `::before`.
- [ ] Mobile: the existing `md:hidden` "Account" block already has an `{isAdmin && <a href="/admin">…</a>}` link — keep it (single entry, drilldown via the on-page tab strip).
- [ ] **Do NOT** add Brand Kits anywhere new. Per founder's instruction, that surface stays out of scope.
- [ ] Verify the sidebar doesn't render an Admin link to non-admins (covered by `useAdminAuth` already; add an explicit unit test).

### 1.3 Top-level admin shell (`src/pages/Admin.tsx` rewrite)
- [ ] Replace the current custom shell with the design's two-zone layout: `.adm` grid `248px 1fr`, with the existing dashboard `Sidebar` in column 1 and `<AdminMain>` in column 2. **Reuse `Sidebar.tsx` — do not render a new sidebar**.
- [ ] Mobile (≤ 900 px): collapse to single column, hide the desktop-only sidebar pieces (the existing `Sidebar.tsx` already has `md:hidden`/`md:block` rules — verify the admin shell respects them).
- [ ] Implement `AdminMain` with three sub-areas: `<AdminTopBar>`, `<AdminHero>`, `<AdminTabStrip>`, then the tab-routed content.
- [ ] `AdminTopBar`: 54 px, `rgba(10,13,15,.7)` bg with `backdrop-filter:blur(10px)`, bottom border `var(--line)`. Children: breadcrumbs (`Operations / <tab label>`), `<Pill cyan dot>production</Pill>`, spacer, `<Pill ok dot>All systems normal</Pill>` (live-derived), Refresh icon-button, Live pill (linked to console live state), gear icon-button → opens existing user dropdown.
- [ ] `AdminHero`: serif 42 px h1 `Admin · control panel` (italic dot in cyan), pulsing-dot sub-line with live counters (`<active> active now · <queue> in queue · $<spend> burned this month · last deploy <rel> ago`). Right side: ghost buttons `Snapshot` (CSV export of overview), `SSH` (opens console tab pre-filtered to errors), cyan `Broadcast` (opens announcements composer prefilled).
- [ ] `AdminTabStrip`: 15 icon-only buttons, 42×38 with rounded-top corners, hover background `var(--panel-2)`, on-state cyan border-bottom + cyan-dim background. Tooltip `data-label` `::after` pseudo-element. Insert `.seg-sep` before `console` and `news` (visual grouping: ops/data | dev | comms | kill).
- [ ] Tab badges: `apikeys=6 cyan pill`, `errors=14 danger pill`, `messages=2 danger pill`, `notifs=3 danger pill`, `announce=2 cyan pill`. Activity tab gets a pulsing green `tab-dot.live` (1.6 s ring animation). Wire counts to live queries (Phase 5 / 11 / 13 / 14 / 16).
- [ ] Mobile (≤ 900 px): tab strip becomes horizontal scroll (no wrap), tooltips disabled, scrollbar hidden.
- [ ] Lazy-load each tab via `React.lazy` to keep initial route light.
- [ ] Keep existing `AdminCommandPalette.tsx` (Cmd+K) and `AdminRecentActions.tsx` mounted in the new shell.

### 1.4 Hero live-counter wiring
- [ ] `<active>` — count of distinct `auth.users` with a `system_logs` row (category=user_activity) in last 5 min. Real-time channel.
- [ ] `<queue>` — `select count(*) from video_generation_jobs where status='pending'`. Real-time on `video_generation_jobs`.
- [ ] `$<spend>` — sum of `api_call_logs.cost` since `date_trunc('month', now())`. 30 s polling — too noisy for realtime.
- [ ] `last deploy <rel> ago` — pulled from `app_settings.last_deploy_at` (set by Vercel/Render deploy hook; if not wired, fall back to current process start time written by worker on boot).

---

## Phase 2 — Backend infrastructure (cross-cutting)

> Several admin tabs require new tables, RPCs, indexes, materialized views, realtime publications, and audit hooks. **Build these before the dependent tabs** so wired-data work isn't blocked. Each migration must include `is_admin(auth.uid())`-gated RLS at create time.

### 2.1 Schedule the materialized-view refresh cron
- [ ] Migration: `SELECT cron.schedule('refresh-admin-views', '*/15 * * * *', $$ SELECT public.refresh_admin_materialized_views(); $$);`. The function exists per `20260419250000_admin_materialized_views.sql`; only the schedule is missing.
- [ ] Add Sentry breadcrumb on the function so missed runs surface in observability.

### 2.2 Schedule existing purge functions
- [ ] `purge-system-logs` daily 03:00 UTC (function exists in `20260419270001_*.sql`).
- [ ] `purge-api-call-logs` daily 03:00 UTC (function exists in `20260419340000_*.sql`).
- [ ] `purge-dead-letter-jobs` daily 03:30 UTC (function exists in `20260419360000_*.sql`).
- [ ] Verify the existing `auto-resolve-stale-flags` cron from `20260427100300_*.sql` still runs.

### 2.3 New materialized views
- [ ] `admin_mv_daily_signups (day date, signups int)` from `auth.users.created_at` — for Analytics signup chart.
- [ ] `admin_mv_funnel_weekly (cohort_week date, signups int, projects int, generations int, paid int)` — for Analytics funnel + cohort heatmap.
- [ ] `admin_mv_project_type_mix (project_type text, count int, last_7d int, last_30d int)` — for Analytics top features.
- [ ] `admin_mv_api_costs_daily (day date, provider text, model text, status text, calls int, spend numeric, avg_ms numeric)` from `api_call_logs` — for API & Costs and Analytics revenue/spend.
- [ ] `admin_mv_job_perf_daily (day date, task_type text, p50_ms numeric, p95_ms numeric, p99_ms numeric)` — for Performance percentiles.
- [ ] All 5 added to the `refresh_admin_materialized_views()` body.
- [ ] Each MV gets a unique index on its primary lookup key; verify `EXPLAIN ANALYZE` for the typical query stays sub-50 ms.

### 2.4 Schema additions to existing tables
- [ ] `video_generation_jobs.started_at timestamptz`, `finished_at timestamptz` — populate from the claim and terminal-write paths in `worker/src/index.ts`.
- [ ] `system_logs.fingerprint text`, `resolved_at timestamptz`, `resolved_by uuid REFERENCES auth.users(id)`, `sentry_issue_id text`, `worker_id text`, `level text GENERATED ALWAYS AS (...) STORED`.
  - [ ] Indexes: `(fingerprint, created_at desc) WHERE category='system_error'`, `(level, created_at desc)`, `(worker_id, created_at desc) WHERE worker_id IS NOT NULL`, `(user_id, created_at desc)` (composite to replace user-only index).
- [ ] `api_call_logs.worker_id text` — backfill to NULL, write going forward via worker.
  - [ ] Indexes: `(user_id, created_at desc)`, `(cost desc)`.
- [ ] `profiles.last_active_at timestamptz`, `profiles.marketing_opt_in boolean default false`, `profiles.newsletter_unsubscribed_at timestamptz`.
  - [ ] Index: `(marketing_opt_in) WHERE marketing_opt_in = true`.

### 2.5 New tables (greenfield)
- [ ] `admin_message_threads` — see Phase 13.1 for full schema.
- [ ] `admin_messages` — see Phase 13.1.
- [ ] `notification_templates` — see Phase 14.1.
- [ ] `user_notifications` — see Phase 14.1.
- [ ] `newsletter_campaigns` — see Phase 15.1.
- [ ] `newsletter_sends` — see Phase 15.1.
- [ ] `announcements` — see Phase 16.1.
- [ ] `announcement_dismissals` — see Phase 16.1.
- [ ] `worker_heartbeats` — see Phase 10.4.
- [ ] `user_provider_keys` — see Phase 7.1 (replaces / extends `user_api_keys`).
- [ ] All tables: `ENABLE ROW LEVEL SECURITY; FORCE ROW LEVEL SECURITY;`. User-scope policy where applicable, admin SELECT policy via `is_admin(auth.uid())`, service-role full access, anon DENY restrictive. All write paths via SECURITY DEFINER RPCs that gate on `is_admin()` and write `admin_logs` rows.

### 2.6 Realtime publication additions
- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE public.system_logs;` (Console live tail).
- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE public.video_generation_jobs;` (Generations live status flips).
- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE public.feature_flags;` (Kill switches mirror).
- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;` (master kill mirror).
- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE public.user_notifications;` (in-app push).
- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE public.announcements;` (banner refresh without reload).
- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_messages;` (inbox push).
- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_message_threads;` (inbox thread state).
- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE public.dead_letter_jobs;` (Generations DLQ live).

### 2.7 RLS hardening on existing tables
- [ ] `feature_flags` — add admin SELECT policy `USING (public.is_admin(auth.uid()))`. Writes stay RPC-only.
- [ ] `deletion_requests` — add admin SELECT policy.
- [ ] `webhook_events` — add admin SELECT policy.
- [ ] `referral_codes`, `referral_uses` — add admin SELECT policies for fraud review.
- [ ] `rate_limits` — replace the `USING (false)` with `USING (public.is_admin(auth.uid()))`.
- [ ] `voice_consents` — add admin SELECT for compliance review.
- [ ] `scene_versions`, `project_characters` — add admin SELECT for Generations drilldown.
- [ ] **Never** expose `user_api_keys` (or `user_provider_keys`) plaintext keys to admins. Build a safe view `admin_v_user_api_keys` exposing only `(user_id, has_<provider> bool, last_validated_at, status, updated_at)` and admin SELECT on the view.

### 2.8 Auth helpers
- [ ] `public.is_super_admin(uuid) RETURNS boolean` — same shape as `is_admin`. Add `super_admin` to the `app_role` enum.
- [ ] Migrate the most destructive RPCs to require super_admin: `admin_force_signout`, `admin_hard_delete_user`, `admin_set_master_kill_switch`, `admin_cancel_newsletter_in_flight`.
- [ ] `public.current_admin_id() RETURNS uuid STABLE` — returns `auth.uid()` if `is_admin()` else NULL. Use inside RLS join policies.
- [ ] Backfill: identify which existing `admin` users should be promoted to `super_admin`. Default to none — promotion happens via SQL by a service-role operator only.

### 2.9 Unified audit log hardening
- [ ] Add `request_id text` column to `admin_logs` for multi-step correlation. Backfill NULL.
- [ ] Sweep every admin write path (RPCs + edge functions) and ensure each emits exactly one `admin_logs` row. Audit-log read-side actions when the data is sensitive (user_details, api_call_detail).
- [ ] `admin_logs` realtime publication — add to publication so the Recent Actions popover updates without polling.
- [ ] Index `(admin_id, created_at desc)`, `(action, created_at desc)`, `(target_id) WHERE target_id IS NOT NULL`.

### 2.10 Worker emit-points sweep
- [ ] Add a worker-side helper `worker/src/lib/audit.ts` that wraps `writeSystemLog` with structured event_type strings (a TS union exported for typing across handlers).
- [ ] Audit every `try/catch` in `worker/src/handlers/*` and confirm catches call `writeSystemLog({ category: 'system_error', ... })`. Required handlers: `handleCinematicVideo`, `handleCinematicAudio`, `handleCinematicImage`, `handleMasterAudio`, `handleFinalize`, `exportVideo`, `handleAutopostRun`, `handleAutopostRerender`, `generateVideo`, `handleRegenerateImage`, `handleRegenerateAudio`, `handleUndoRegeneration`, `handleVoicePreview`, `handleCloneVoice`.
- [ ] Add user-activity emits at: signup (via `handle_new_user` trigger), login (already covered by Supabase auth events — confirm), voice clone completion, project create, deletion request, deletion cancel, settings display name change, settings email change, settings password change.
- [ ] Worker logger reads `process.env.WORKER_ID || os.hostname()` and stamps `worker_id` on every `system_logs` and `api_call_logs` row.

### 2.11 Edge function logging
- [ ] New `supabase/functions/_shared/log.ts` mirroring worker's `writeSystemLog`. Imports `createClient` with service role, writes a `system_logs` row.
- [ ] Replace `console.log`-based `logStep` helpers in `admin-stats`, `stripe-webhook`, `delete-account`, `customer-portal`, `clone-voice`, `clone-voice-fish`, `delete-voice`, `delete-voice-fish`, `manage-api-keys`, `admin-force-signout`, `admin-hard-delete-user`, `share-meta`, `serve-media`.

### 2.12 RPC: `is_admin` performance
- [ ] Verify `is_admin(uuid)` returns within 1 ms p95 — this function fires on every admin RLS check. Add a cache layer (`SECURITY DEFINER` + memoization via a `STABLE` function checking once per query).

---

## Phase 3 — Tab: Overview

### 3.1 KPI grid (6 tiles)

| # | Label | Wire to | Formula | Tone |
|---|---|---|---|---|
| 1 | `Active users · 24h` | `admin_mv_daily_active_users` | `SELECT count FROM mv WHERE day = current_date` | cyan |
| 2 | `MRR` | edge fn `admin-stats/revenue_stats` (Stripe) + `admin_mv_daily_revenue` (credit packs) | sum of monthly subscription revenue + 1/12 of trailing 12 mo credit packs | — (good) |
| 3 | `Generations · today` | `admin_mv_daily_generation_stats` | `count WHERE day = current_date` | — |
| 4 | `API spend · MTD` | `admin_mv_api_costs_daily` | `sum(spend) WHERE day >= date_trunc('month', now())` plus monthly budget from `app_settings.monthly_api_budget` | — (neutral) |
| 5 | `Errors · 1h` | `system_logs` | `count WHERE category='system_error' AND created_at > now() - interval '1 hour'` | danger |
| 6 | `Open tickets` | `admin_message_threads` | `count WHERE status IN ('open','answered')` | — (neutral) |

- [ ] All 6 tiles wired with React Query, 30 s `staleTime`.
- [ ] Each KPI's delta vs. prior period rendered (`+12.4% vs yest`, etc.) — pull prior-period value from same MV.
- [ ] Sparklines on tiles 1-4 use last 14 d from the MVs.
- [ ] `MRR` tile: defer the Stripe call to an edge fn so the client doesn't hold the Stripe token. Cache result in `app_settings.stripe_mrr_snapshot` for 5 min.

### 3.2 Live activity feed (left card, `cols-2-1`)
- [ ] Fetch latest 20 from a unified feed via new RPC `admin_activity_feed(p_since => now() - interval '24 hours', p_limit => 20)`. Implementation in Phase 5.2.
- [ ] Realtime subscription to `system_logs` (admin RLS-gated) auto-prepends new rows.
- [ ] Top-right filter `.btn-ghost` group: `Live` (active), `All`, `Generations`, `Billing`. Wire to query filter: Live = realtime on, All = all categories, Generations = filter to `event_type LIKE 'gen.%'`, Billing = `event_type LIKE 'pay.%'` ∪ `credit_transactions.txn_type IN ('purchase','refund','subscription_grant')`.
- [ ] Click any user name → opens `<UserDrawer>`. Pull `u` from cache via React Query (`['admin', 'users', 'lookup', user_id]`) so no extra round-trip per click.

### 3.3 Cost split donut (right top)
- [ ] Card title `Cost split · MTD`, lbl = total spend (formatted `$N,NNN`).
- [ ] 5-slice donut from `admin_mv_api_costs_daily` grouped by provider, MTD only.
  - Slice colors: Replicate · Video → cyan, ElevenLabs → purple, Replicate · Image → gold, OpenAI → green, Other → muted.
- [ ] Center label: short total + `MTD`.
- [ ] Right legend, top 4 rows + `Other` rolled up.

### 3.4 Top users · 7 d (right bottom)
- [ ] Card title `Top users · 7d`, lbl `by spend`.
- [ ] Query: top 5 users by `sum(api_call_logs.cost) WHERE created_at > now() - interval '7 days'`, joined to `profiles` for name + avatar.
- [ ] Row: `<Avatar/>` + name (ellipsis) + `BarTrack` (width = spent / max_spent) + mono right-aligned spend.
- [ ] Whole row clickable → `openUser(u)`.

### 3.5 Acceptance criteria
- [ ] Page renders in <300 ms p95 with the 6-tile + feed + donut + top-users payload (after MV refresh).
- [ ] Filter chips visually toggle; selection persists in `?activity=<filter>` query.
- [ ] Realtime feed receives a row within 2 s of a worker `writeSystemLog` call (manual smoke test).

---

## Phase 4 — Tab: Analytics

### 4.1 KPI grid (4 tiles)

| Label | Source | Tone |
|---|---|---|
| `DAU · today` | `admin_mv_daily_active_users` current row | cyan |
| `WAU · 7d` | DAU MV last 7 d distinct | cyan |
| `MAU · 30d` | DAU MV last 30 d distinct | good |
| `Stickiness · DAU/MAU` | computed | danger if <13% |

### 4.2 Period segment + body
- [ ] Period state `period: '7d' | '30d' | '90d' | '12mo'`, default `30d`. Synced to `?period=` in URL so it's shareable.
- [ ] DAU bar chart driven by `admin_mv_daily_active_users` filtered by period. Cyan fill.
- [ ] Plan-mix donut from `subscriptions.plan_id` aggregation.
- [ ] Funnel card: 6 stages from `admin_mv_funnel_weekly` summed across selected period. Bar color per stage as in design (visited → cyan-light, sign-up → cyan, complete → cyan, first gen → green, return → purple, upgrade → gold).
- [ ] Cohort retention heatmap (`cols-3` Top countries, Acquisition, Top features cards).
  - [ ] Top countries — derived from `auth.users.raw_user_meta_data->>'country'` (default `Unknown`) — fallback to GeoIP if unset.
  - [ ] Acquisition — derived from `profiles.referrer` (new column needed if not present — verify migration history).
  - [ ] Top features — `admin_mv_project_type_mix` ordered desc.
- [ ] Cohort table: 6 cohort rows × W0–W8 columns. Cell color `rgba(20,200,204, value/110)`; `value > 40` swaps text to `#0A0D0F` (legibility). Null cells em-dash.

### 4.3 Export
- [ ] `Export` ghost button → CSV of the active period's DAU + funnel data via existing `exportRowsAsCsv`.

### 4.4 Acceptance
- [ ] Funnel percentages compute correctly at various period lengths (manual: pick 7d vs 30d, verify ratios).
- [ ] Plan-mix totals match `select count(*) from subscriptions where status='active' group by plan_id`.

---

## Phase 5 — Tab: Activity

### 5.1 Reuses
- [ ] Reuses `<ActivityFeed>` from Phase 0.2 and the realtime channel from Phase 3.2.

### 5.2 New RPC `admin_activity_feed(...)`
- [ ] Signature: `admin_activity_feed(p_since timestamptz, p_user_id uuid default null, p_event_types text[] default null, p_limit int default 100)`.
- [ ] Body: `UNION ALL` across:
  - `system_logs` projecting `(created_at, event_type, category, user_id, message, details, generation_id, project_id)`.
  - `admin_logs` projecting same shape with `category='admin_action'`.
  - `credit_transactions` projecting `(created_at, 'pay.'||txn_type, 'system_info', user_id, ...)`.
  - `subscriptions` events from a new view if exists, else skip.
- [ ] Order by created_at desc, limit p_limit. Cursor via `created_at` for pagination.
- [ ] Gate on `is_admin(auth.uid())`. SECURITY DEFINER.

### 5.3 UI
- [ ] Same shell as Overview's feed (same component, different filter defaults).
- [ ] Top filter bar: search by user (autocompletes from `admin_global_search`), event-type chip group, time-range select (`Last hour | 24 h | 7 d | 30 d | Custom`).
- [ ] Per-row click → expands inline detail card showing the full `details` jsonb pretty-printed. Click on user/project links navigate to those drawers/pages.
- [ ] Live toggle (default on) — toggles realtime channel.
- [ ] Empty state: `No activity in this window. Try a wider range.`.

### 5.4 Acceptance
- [ ] Feed paginates beyond 100 rows via cursor (manual: scroll or click "load more").
- [ ] Search by user_id returns only that user's events.
- [ ] Realtime: a new login emits a row that appears in the UI within 3 s.

---

## Phase 6 — Tab: API & Costs

### 6.1 Decision: collapse `generation_costs` ⟹ `api_call_logs`
- [ ] Drop the columnar `generation_costs` table (or keep for historical) and aggregate from `api_call_logs.cost` for all live tiles.
- [ ] Replace existing `get_generation_costs_summary()` with a new `admin_api_cost_breakdown(p_since timestamptz, p_group_by text)` RPC. Group by ∈ {provider, model, user, task_type, day, week}.
- [ ] Add `admin_top_expensive_calls(p_since, p_limit)` RPC.

### 6.2 KPI grid (4 tiles) — wire to `admin_mv_api_costs_daily`

| Label | Formula | Tone |
|---|---|---|
| `API calls · 30d` | `sum(calls) WHERE day >= now()-30d` | — |
| `API spend · MTD` | `sum(spend) WHERE day >= date_trunc('month', now())` + delta vs prior period | — |
| `Avg latency · p95` | `percentile_cont(0.95) FROM api_call_logs WHERE created_at > now()-30d` | — |
| `Error rate` | `sum(status='error')::float / sum(*)` last 30 d | danger if >0.5% |

### 6.3 Per-provider table
- [ ] Sort by costMo desc. Columns: Endpoint, Kind, Calls (period), $/call, $/month, p95 latency, Err%, Trend (sparkline 120×26), Action.
- [ ] Period segment: `7d | 30d | 90d`. Provider chip filter dynamic from `select distinct provider from api_call_logs`.
- [ ] Endpoint cell: `provider · model` strong + mono `id`.
- [ ] Kind pill: Video → cyan, Voice → purple, Image → gold, else default.
- [ ] Action: `<button>` opens detail drawer (reuses existing `AdminApiCalls.tsx` detail drawer).
- [ ] Export CSV button (right of section header).

### 6.4 Cost-per-generation card (cols-2 left)
- [ ] Five rows from `admin_api_cost_breakdown(group_by => 'task_type')`:
  - `Cinematic video (Hailuo)` → cyan bar
  - `Explainer (Flux + TTS)` → green bar
  - `Voice clone training` → purple bar
  - `Image regeneration` → gold bar
  - `Script (GPT-4o)` → light cyan bar
- [ ] Bar width = cost / max_cost (cap at 2.4 in admin demo; live, use actual max).

### 6.5 API calls weekly card (cols-2 right)
- [ ] 14-day vertical bar chart from `admin_mv_api_costs_daily` grouped by day.
- [ ] Bottom row of three stats: Peak hour (UTC), Quietest hour, Forecast EOM (current MTD spend / days_in_month_so_far × days_in_month).

### 6.6 Acceptance
- [ ] Provider chip filter narrows the per-provider table.
- [ ] Period switch refetches and re-renders within 500 ms.
- [ ] Cost numbers reconcile with `select sum(cost) from api_call_logs where ...` (manual ad-hoc query).

---

## Phase 7 — Tab: API Keys

### 7.1 New schema `user_provider_keys`
- [ ] Migration:
  ```sql
  CREATE TABLE public.user_provider_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('openrouter','elevenlabs','fish_audio','hypereal','grok','lyria','lemonfox','smallest','google_tts','replicate','openai','sendgrid','stripe','sentry')),
    key_ciphertext text NOT NULL,
    last_validated_at timestamptz,
    last_validation_error text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','revoked')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider)
  );
  CREATE INDEX ON public.user_provider_keys (provider, status);
  ```
- [ ] RLS: user reads own metadata only (no decrypt); admin via the safe view below.
- [ ] Safe admin view `admin_v_user_provider_keys (user_id, provider, status, last_validated_at, last_error, created_at)` — never includes ciphertext.
- [ ] Migrate existing `user_api_keys` rows into `user_provider_keys` (gemini → google_tts? verify intent; replicate → replicate). Decision: keep `user_api_keys` for back-compat, add a one-way mirror trigger.

### 7.2 Internal API keys (server-issued tokens)
- [ ] New table `internal_api_keys (id, name, scope text[], token_hash text, prefix text, created_by, created_at, last_used_at, calls_count int default 0, status text default 'active')`.
- [ ] Token format `mm_live_<24-char-base32>` or `mm_test_<24>`. Store hashed (sha-256), display only the last 4 chars.
- [ ] RPCs:
  - `admin_create_internal_key(p_name text, p_scope text[]) returns (id uuid, token text)` — returns plaintext ONCE.
  - `admin_rotate_internal_key(p_id uuid)` — issues new, marks old `revoked`.
  - `admin_revoke_internal_key(p_id uuid)`.
- [ ] Increment `calls_count` and `last_used_at` from a request middleware in worker / edge fns when the token is presented.

### 7.3 Webhooks
- [ ] New table `webhooks (id, url, events text[], status text default 'active', last_delivery_at, success_24h int, error_24h int, created_by, created_at)`.
- [ ] Inbound webhook receiver: existing `stripe-webhook`, `replicate-webhook` (build), `sentry-webhook` (build), `sendgrid-webhook` (build). Each writes to `webhook_events` and updates `webhooks` counters via trigger.
- [ ] RPCs `admin_add_webhook`, `admin_test_webhook` (sends a synthetic event), `admin_delete_webhook`.

### 7.4 UI

#### 7.4.1 KPI grid (4 tiles)
- [ ] `Active keys` — `count(*) FROM internal_api_keys WHERE status='active'`. Sub-label `<internal> internal · <service> service`.
- [ ] `API calls · 24h` — `sum(calls_count) FROM internal_api_keys WHERE last_used_at > now()-1d`.
- [ ] `Last rotation` — `max(rotated_at)` (add column if needed). Display days ago + due in N (90 d cycle).
- [ ] `Suspicious requests` — count from `auth_events` where status=fail in last 7 d (greenfield index — see Phase 7.5).

#### 7.4.2 Internal API keys list
- [ ] Six rows render style per design: name 13.5/500 + scope pill, key token mono in panel-3 chip, Copy button, mono muted line `created … · last used … · N calls`.
- [ ] Right cell actions: Edit (rename/scope), Rotate, Trash (revoke).
- [ ] Toolbar: `Rotate all`, `+ New API key` (opens modal with name + multi-select scope).
- [ ] When `+ New API key` succeeds, show one-time modal with the plaintext token + Copy button + warning "you will not see this again".

#### 7.4.3 Outbound provider keys (cols-2 left)
- [ ] Row per provider from `admin_v_user_provider_keys` aggregated to "platform-level" (the founder's own keys, stored under a designated admin user). UI shows truncated key (first 5 + last 4), status pill (ok / warn for `last_validation_error IS NOT NULL`), last call timestamp, Test button.
- [ ] Test button calls a new edge function `admin-test-provider-key(provider)` that invokes a known-cheap call against the provider and updates `last_validated_at` + error.

#### 7.4.4 Webhooks (cols-2 right)
- [ ] Row per `webhooks` row: URL (mono, break-all), events (joined comma-separated), status counter (`N ok` good · `M err` warn).
- [ ] `+ Add webhook` button at bottom.

#### 7.4.5 Recent key activity table
- [ ] 5 cols: When, Key (truncated mono), Action (Used/Created/Rotated/Revoked), By (user/email), IP.
- [ ] Source: a new `internal_api_key_events` table written by the auth middleware (insert per action).

### 7.5 Acceptance
- [ ] Creating a key returns plaintext exactly once.
- [ ] Rotating a key invalidates the old token within 60 s (verify via curl with the old token after rotation).
- [ ] No plaintext key ever appears in `admin_v_user_provider_keys`.

---

## Phase 8 — Tab: Users (+ drawer)

### 8.1 RPCs
- [ ] `admin_users_list(p_search text, p_plan text, p_status text, p_flag_state text, p_page int, p_limit int)` — push filter + join into a SECURITY DEFINER plpgsql RPC. Replaces the client-side fan-out in `admin-stats/subscribers_list`.
- [ ] `admin_user_full_detail(p_user_id uuid)` — single round-trip aggregate (replaces 8-query `user_details` action). Returns jsonb with profile, subscription, credits, recent generations, recent api_call_logs, flags, recent system_logs (user_activity).
- [ ] `admin_bulk_suspend(p_user_ids uuid[], p_reason text)`, `admin_bulk_grant_credits(p_user_ids uuid[], p_amount int, p_reason text)` — bulk admin actions.

### 8.2 Last-active tracking
- [ ] Either nightly job: `UPDATE profiles SET last_active_at = sl.last FROM (SELECT user_id, max(created_at) AS last FROM system_logs WHERE category='user_activity' GROUP BY user_id) sl WHERE profiles.user_id = sl.user_id;` OR live RPC `bump_my_last_active()` called by client on focus + every 60 s.
- [ ] Pick: live RPC (lower latency for "active now" hero counter). Cron job is a fallback for users not in browser.

### 8.3 KPI grid (4 tiles)
- [ ] `Total users` — `count from profiles where deleted_at is null`. Spark from `admin_mv_daily_signups`.
- [ ] `Paying` — `count from subscriptions where status='active'`. Sub-label conversion %.
- [ ] `Studio plan` — `count from subscriptions where plan_id='studio'`. Delta from prior week.
- [ ] `Flagged` — `count from user_flags where resolved_at is null`. Sub-label `<auto> auto · <manual> manual`.

### 8.4 Directory toolbar
- [ ] Search input (`q` state, 200 ms debounce, min 2 chars). Searches name, email, user_id.
- [ ] Plan chip group: All / Studio / Pro / Free.
- [ ] Status chip group: All / active / flagged / paused.
- [ ] Export CSV button → calls `admin_users_list` with current filters and writes via `exportRowsAsCsv`.

### 8.5 Users table
- [ ] Columns per design: User · Plan · Status · Last sign-in (sortable) · Generations (sortable) · Lifetime spent (sortable) · Credits · Errors (sortable) · Location · Actions.
- [ ] Row click → `openUser(u)`. `e.stopPropagation()` on actions cell.
- [ ] Action cell: 3 mini buttons — Mail (opens drawer Communicate tab), Credit (opens drawer Billing tab), More (opens drawer Overview tab).
- [ ] Errors cell color: `>3` warn, `>0` gold, else ink-dim.
- [ ] `.scroll` wrapper with `maxHeight: 600` and sticky header.
- [ ] Pagination: server-side via `p_page` / `p_limit`. Default 50/page. Show `Showing 1–50 of 12,842` footer.

### 8.6 User drawer (`UserDrawer`)
- [ ] Right-side panel, 640 px max 100vw, slide-in 250 ms cubic-bezier. Overlay 50 % black + 2 px backdrop blur.
- [ ] Top: large avatar 54×54, serif 20 name, mono `email · id`, X close button.
- [ ] Tabs (drawer-internal): Overview, Activity, Billing, Communicate, Danger.

#### 8.6.1 Overview
- [ ] 3 mini KPIs: Plan / Total spent (lifetime) / Credits remaining.
- [ ] Profile card 2-col grid: Joined, Last sign-in (+ device), Location, Generations · errors.
- [ ] Usage trend BarChart (last 14 d gens/day from `admin_user_full_detail`).

#### 8.6.2 Activity
- [ ] Reuse `<ActivityFeed>` filtered to `admin_activity_feed(p_user_id => user.id)` last 30 d.

#### 8.6.3 Billing
- [ ] Table: Date, Description, Amount (right), Status. Source: `credit_transactions` for this user where `txn_type IN ('purchase','subscription_grant','refund')`.
- [ ] Adjust credits card: amount input (mono, `+/-`) + reason input + Apply button → `admin_grant_credits` (existing RPC) with reason.
- [ ] Refund card: most recent Stripe charge id (from edge fn `admin-stats/user_details` Stripe-side fetch) + Refund button → new edge fn `admin-refund-charge(charge_id)` calling Stripe.

#### 8.6.4 Communicate
- [ ] Subject + Message (textarea) → submit → `admin_open_thread(user_id, subject, body)` (Phase 13.2).
- [ ] Email-copy toggle (default on) → triggers edge fn `notify-user-of-message`.
- [ ] Push toggle → fires `admin_send_notification([user_id], title, body, ...)` (Phase 14.2).
- [ ] Push-only headline field → `admin_send_notification([user_id], headline, '', null, 'info')`.

#### 8.6.5 Danger
- [ ] Pause account → `admin_set_user_status(p_user_id, 'paused', reason)` (new RPC; flips a column on profiles or a flag in user_flags; reuses the existing soft-delete plumbing).
- [ ] Force sign-out → existing edge fn `admin-force-signout`.
- [ ] Reset password → triggers Supabase `auth.admin.updateUserById` with `password_reset_token` (or generates a magic link). New edge fn `admin-send-reset-link`.
- [ ] Delete account → typed-confirm dialog requiring email; calls existing edge fn `admin-hard-delete-user` (super_admin gated).

### 8.7 Acceptance
- [ ] Search returns within 300 ms p95 across 12k users.
- [ ] Drawer opens in <200 ms after click; slide animation completes at 60 fps on a Chromebook-class device.
- [ ] Every action emits an `admin_logs` row with the admin's id and the target user's id.
- [ ] Bulk suspend + credit-grant operate on selected rows (multi-select via row checkboxes — add new state for selected_ids).

---

## Phase 9 — Tab: Generations

### 9.1 Status enum normalization
- [ ] Worker writes `'completed'` and `'failed'`; this UI must filter on those (NOT the legacy `'complete'`/`'error'` strings flagged in chat3.md). Sweep `AdminGenerations.tsx` and any helpers.

### 9.2 KPI grid (4 tiles)
- [ ] `Generations · today` — `admin_mv_daily_generation_stats` current row.
- [ ] `Success rate` — `sum(status='completed')::float / sum(*) last 24h`.
- [ ] `Median time` — `percentile_cont(0.5) (finished_at - started_at)` last 1 h.
- [ ] `In queue` — `count(*) from video_generation_jobs where status='pending'`. Sub-label `N over SLA (>5m)`.

### 9.3 By type · last 7 days (cols-3)
- [ ] Three cards (Cinematic / Explainer / Voice). Source: `admin_mv_daily_generation_stats` joined to project_type.
- [ ] Per card: serif count + mono cost + err% + sparkline 300×48.

### 9.4 Recent generations table
- [ ] Columns: ID · User · Type · Model · Output · Cost (right) · Status · When · Action.
- [ ] Server-side filter via `admin_v_jobs_with_project` (new view from Phase 9.6).
- [ ] Search by id/user/prompt — full-text on payload jsonb (add `gin` index `payload_search_idx ON video_generation_jobs USING gin (payload jsonb_path_ops)`).
- [ ] Filter button → multi-select dropdown for status, type, date range, worker_id.
- [ ] Refresh button — manual refetch.
- [ ] Action: View → opens drilldown drawer with full payload, error message, generation_costs join, related api_call_logs.
- [ ] Realtime subscription on `video_generation_jobs` updates rows in place.

### 9.5 Drilldown drawer
- [ ] Reuses pattern from existing `AdminGenerations.tsx` drilldown.
- [ ] Sections: Job info, Pipeline trace (from `system_logs` filtered to this `generation_id`), API calls (from `api_call_logs` joined), Cost breakdown, Error stack.
- [ ] Actions: Retry (calls `admin_retry_generation`), Cancel + refund (calls `admin_cancel_job_with_refund`), Force complete (new RPC `admin_force_complete_job` — Phase 9.7), Archive (existing path).

### 9.6 New view
- [ ] `CREATE VIEW public.admin_v_jobs_with_project AS SELECT j.*, p.title AS project_title, p.format, p.style, p.length, p.project_type FROM public.video_generation_jobs j LEFT JOIN public.projects p ON p.id = j.project_id;`. Inherits RLS from base tables.

### 9.7 New RPCs
- [ ] `admin_force_complete_job(p_job_id uuid, p_result jsonb, p_reason text)` — flips status to 'completed', sets `result`, audit-logs.
- [ ] `admin_requeue_dead_letter(p_dlq_id uuid)` — re-inserts DLQ row into `video_generation_jobs` with `_restartCount` bumped.

### 9.8 Dead-letter section (new card below "Recent generations")
- [ ] List of `dead_letter_jobs` last 30 d. Columns: When, Task type, User, Error, Attempts, Action (Requeue, Inspect).

### 9.9 Acceptance
- [ ] Realtime: a job flipping to 'failed' updates the row's status pill within 2 s without refetch.
- [ ] Force-complete writes to admin_logs.
- [ ] Dead-letter requeue produces a new pending job.

---

## Phase 10 — Tab: Performance

### 10.1 KPI grid (6 tiles)
- [ ] `Worker concurrency` — `app_settings.worker_concurrency_override` or auto-tuned default. Sub-label `N idle`.
- [ ] `Avg job time` — `avg(finished_at - started_at)` last 1 h.
- [ ] `Queue depth · now` — `count from video_generation_jobs where status='pending'`. Sub-label `N over SLA (>5m)`.
- [ ] `Throughput · 1h` — `count from video_generation_jobs where finished_at > now()-1h`. Sub-label `<rate>/min`.
- [ ] `Memory · pod p95` — from `worker_heartbeats` (new — Phase 10.4) `percentile_cont(0.95) memory_pct`.
- [ ] `CPU · pod p95` — same source.

### 10.2 Pipeline phase timing card (cols-2-1 left)
- [ ] 5 rows per design: Script, Voiceover, Image, Video render, Compose. Bar fill colored per phase.
- [ ] Source: new MV `admin_mv_pipeline_phase_timing` aggregating per-phase duration from `system_logs` `event_type IN ('phase.script.completed', 'phase.audio.completed', 'phase.image.completed', 'phase.video.completed', 'phase.export.completed')` with `details->>'phase_duration_ms'` extracted. Worker must emit these (Phase 2.10 sweep).
- [ ] Right side mono: `avg <Xs> · p95 <Ys>` with p95 colored warn if >100 s.

### 10.3 Workers card (cols-2-1 right)
- [ ] One nested card per `worker_heartbeats` row.
- [ ] Header: name + status pill (`ok` if `last_beat_at > now()-30s`, else `warn`).
- [ ] Body 3-col grid: Jobs (in_flight) · Mem (memory_pct, warn if >80) · Up (now - started_at).
- [ ] Trailing button: `Restart degraded pod` — calls a new RPC `admin_request_worker_restart(worker_id)` that flips a flag in `worker_heartbeats.restart_requested`. Worker checks this flag each loop iteration and gracefully exits if true; supervisor (Render) restarts.

### 10.4 New table `worker_heartbeats`
```sql
CREATE TABLE public.worker_heartbeats (
  worker_id text PRIMARY KEY,
  host text,
  last_beat_at timestamptz NOT NULL DEFAULT now(),
  in_flight int NOT NULL DEFAULT 0,
  concurrency int NOT NULL DEFAULT 0,
  memory_pct numeric,
  cpu_pct numeric,
  version text,
  started_at timestamptz NOT NULL DEFAULT now(),
  restart_requested boolean NOT NULL DEFAULT false
);
```
- [ ] RLS: admin SELECT; service-role full access; anon DENY.
- [ ] Worker `index.ts`: every 15 s, UPSERT a row with current state. `os.totalmem()` / `os.freemem()` for memory_pct, OS-load-average normalized for cpu_pct.
- [ ] Janitor cron: delete rows where `last_beat_at < now() - interval '5 min'` (dead pods).

### 10.5 New RPC
- [ ] `admin_perf_percentiles(p_since timestamptz, p_dimension text)` — `dimension ∈ {provider, task_type}`. Returns `(label, p50, p95, p99, count)` rows.

### 10.6 Concurrency override
- [ ] Slider control (existing pattern from `AdminFlags.tsx` — onValueCommit) calling `admin_set_worker_concurrency_override(p_value int)`. Range 0–60.

### 10.7 Acceptance
- [ ] All 3 worker cards refresh every 15 s without flicker (use React Query `refetchInterval: 15_000`).
- [ ] Restart-degraded triggers a worker pod restart within 30 s (confirm via Render logs).

---

## Phase 11 — Tab: Errors

### 11.1 KPI grid (4 tiles)
- [ ] `Errors · 1h` — `count from system_logs where category='system_error' and created_at > now()-1h`.
- [ ] `Affected users · 1h` — `count distinct user_id from system_logs where category='system_error' and created_at > now()-1h`. Sub-label percentage of active users.
- [ ] `Crash-free sessions` — `1 - (sessions with any error / total sessions)` last 24 h. Needs a `sessions` derivation — see Phase 11.4.
- [ ] `Open incidents` — `count from incidents where status='open'` (new table — see Phase 11.5). Default 0.

### 11.2 Top error signatures table
- [ ] Source: `admin_error_groups(p_since => now()-1d, p_limit => 50)`.
- [ ] Columns: Signature (mono colored `#FFD18C`) · Severity · Events (right) · Users (right) · First seen · Last seen · Actions.
- [ ] Severity derived: errors with `count > 30` = high, `> 10` = medium, else low.
- [ ] Actions: Stack (opens detail drawer with stack trace + sample log + linked Sentry issue) · Resolve (calls `admin_resolve_error_group(fingerprint, notes)`).

### 11.3 New RPCs / schema additions (already covered Phase 2.4 partially)
- [ ] `system_logs.fingerprint`, `resolved_at`, `resolved_by`, `sentry_issue_id` columns.
- [ ] `admin_error_groups(p_since timestamptz, p_limit int)` — `GROUP BY fingerprint`, returns `(fingerprint, count, first_seen, last_seen, sample_message, sample_stack, severity)`.
- [ ] `admin_resolve_error_group(p_fingerprint text, p_notes text)` — bulk-update + audit log.
- [ ] Worker fingerprint computation: `sha1(event_type || normalized_message)` where `normalized_message` strips numbers, UUIDs, paths.

### 11.4 Sessions concept
- [ ] New view `admin_v_sessions` derived from `auth_events` (a new table for auth signals — see Phase 11.6) grouping by `(user_id, session_started_at)` where session is delimited by 30-min idle gaps.
- [ ] Crash-free formula: `(sessions without system_error) / total sessions`.

### 11.5 Incidents (lightweight)
- [ ] New table:
  ```sql
  CREATE TABLE public.incidents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('high','medium','low')),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved')),
    fingerprint text,
    started_at timestamptz NOT NULL DEFAULT now(),
    acknowledged_at timestamptz,
    resolved_at timestamptz,
    notes text
  );
  ```
- [ ] Auto-create from a worker side-channel: if an error fingerprint exceeds 30 events in 5 min and no open incident exists for that fingerprint, insert one. New RPC `auto_open_incident_if_threshold(fingerprint, count)`.

### 11.6 Auth events (for sessions + suspicious-request KPI)
- [ ] New table `auth_events (id, user_id, event_type ['login','login.fail','logout','password.reset','signup'], ip, user_agent, created_at)`. Populated from `_shared/log.ts` in auth edge fns.

### 11.7 Errors by surface (cols-3)
- [ ] Three cards (Web app / Worker · render / Edge functions). Source: `admin_error_groups` partitioned by `details->>'surface'` (worker logger should set this).

### 11.8 Acceptance
- [ ] Resolve action sets `resolved_at` on every matching `system_logs` row and writes one admin_logs row.
- [ ] Open in Sentry button links to `https://sentry.io/issues/?query=fingerprint:<value>`.
- [ ] New errors appear in the table within 5 s via realtime channel on `system_logs`.

---

## Phase 12 — Tab: Console

### 12.1 Live tail
- [ ] Realtime subscription on `system_logs` (admin RLS gates it). Buffer 500 most-recent rows in client state.
- [ ] Pause/Resume button toggles the subscription. When paused, show `Stream paused — N new since paused` chip.
- [ ] Auto-scroll mode: when paused = false, scroll to bottom on each new row. When user scrolls up, auto-disable auto-scroll until they scroll back to bottom.

### 12.2 Filters
- [ ] Level chip group: All / OK / Info / Debug / Warn / Error. Maps to `system_logs.level` (generated column from Phase 2.4).
- [ ] Grep input (`input.mono`) supports `user:<id>` `level:<lvl>` `src:<event_type_prefix>` `"<substring>"` syntax. Parse client-side, push to server-side `WHERE` clauses on the realtime subscription's filter (or a fallback `select` query when filter is too complex).

### 12.3 Rendering
- [ ] Container: `#06090b` bg, line border, 10 px radius, 14×16 padding, height 440 px (440 px desktop / `auto` mobile), `overflow-y: auto`, mono 11.5 / 1.65 line-height / .01em letter-spacing.
- [ ] Each `.line`: flex with `.ts` (170 px ink-mute), `.lvl` (48 px uppercase 10/.1em), `.src` (160 px ink-mute ellipsis), `.msg` (flex:1 ink-dim ellipsis).
- [ ] Level color map: ok=`--good`, info=`#7ad6e6`, debug=`--purple`, warn=`--warn` (msg ink), err=`--warn` lvl + `#FFD18C` msg.
- [ ] Webkit scrollbar 8 px / `--line-2` thumb.
- [ ] Click a line → expand inline detail with full `details` jsonb pretty-print, copy-id button, view-related-logs button (filters by generation_id or job_id).

### 12.4 cols-3 summary cards (below console)
- [ ] By level · 1h — count per level from `system_logs`.
- [ ] Top sources — `select event_type, count(*) from system_logs group by event_type order by 2 desc limit 5`.
- [ ] Search · grep — replicate the grep input here for discoverability.

### 12.5 Export
- [ ] Export ghost button → CSV of currently-buffered + filtered logs.

### 12.6 Acceptance
- [ ] Console keeps up with 100 logs/sec without UI lag (use windowing — `react-virtual`).
- [ ] Grep `level:err` filters live stream + back-buffer.
- [ ] Pause stops new appends; banner shows count of dropped messages.

---

## Phase 13 — Tab: Messages

### 13.1 New schema
- [ ] `admin_message_threads (id, user_id, subject, status, last_message_at, created_at, closed_at, closed_by)` per Phase 2.5.
- [ ] `admin_messages (id, thread_id, sender_id, sender_role, body, attachments jsonb, read_at, created_at)`.
- [ ] RLS: user reads/writes own threads/messages; admin reads/writes all (gated `is_admin()`).
- [ ] Realtime publication on both.

### 13.2 New RPCs
- [ ] `open_thread_as_user(p_subject text, p_body text)` — user-callable; creates a thread + first user message.
- [ ] `admin_open_thread(p_user_id uuid, p_subject text, p_body text)` — admin creates an admin-initiated thread.
- [ ] `admin_post_reply(p_thread_id uuid, p_body text, p_attachments jsonb)` — appends admin message, bumps `last_message_at`, sets thread status='answered'.
- [ ] `admin_close_thread(p_thread_id uuid, p_notes text)` — sets status='closed' + audit-logs.
- [ ] `mark_message_read(p_message_id uuid)` — user-side or admin-side (writes `read_at`).
- [ ] `admin_flag_thread(p_thread_id uuid, p_flag text[])` — adds tags.

### 13.3 New edge function `notify-user-of-message`
- [ ] Triggered after `admin_post_reply` (DB trigger or app-side call). Sends a Resend email to the user with the admin reply.

### 13.4 Inbound message ingestion
- [ ] Marketing site contact form → calls a new edge function `support-create-thread` that finds-or-creates a profile by email and inserts into `admin_message_threads` + `admin_messages`.
- [ ] Inbound email via Resend Inbound (if available) OR a simple `support@motionmax.io` mailbox forwarder + parsing edge fn (defer).

### 13.5 KPI grid (4 tiles)
- [ ] `Open tickets` — `count where status IN ('open','answered')`. Tone danger if any urgent.
- [ ] `Unread` — `count of admin_messages where sender_role='user' and read_at IS NULL`. Sub-label "oldest <rel>".
- [ ] `Avg first reply` — `avg(first_admin_message_at - thread.created_at)` last 30 d.
- [ ] `Sat score · 30d` — when feedback added (defer: TODO note).

### 13.6 Inbox UI (`grid-template-columns: 340px 1fr`, height 640 px)
- [ ] Left list: rows with avatar (TODO: use the user's name initial), subject (12.5 ink-dim ellipsis), preview (11.5 muted, 2-line clamp), tags pills.
- [ ] Selected row: panel-2 bg + `inset 3px 0 0 var(--cyan)` shadow.
- [ ] Unread indicator: 7×7 cyan dot before name.
- [ ] Filter chips above list: All / Unread / Billing / Bugs / Sales / Churn.
- [ ] Right pane (`.inbox-detail`):
  - Header: subject (serif 20), `who` mono with email + plan + when. Action buttons: Reply (focuses textarea), Flag (toggles flag tag), Trash (closes thread).
  - Body: `whiteSpace: pre-wrap`, render the latest `admin_messages` body. Click "Show thread" to expand all messages chronologically.
  - Attachments: `.attach` chips with paperclip icon + name + size.
  - Reply footer: textarea + paperclip / Templates / Add credits buttons + `Mark resolved` toggle + Send button.

### 13.7 Templates
- [ ] New table `support_templates (slug PK, title, body, created_at, updated_at)`. Seed with: `welcome`, `refund_processed`, `bug_acknowledged`, `feature_logged`, `closing_thread`.
- [ ] Templates picker dropdown when clicking the Templates button — pastes body into textarea.

### 13.8 Acceptance
- [ ] Reply sends email + writes admin_messages row + updates thread status.
- [ ] Add credits button apply directly without leaving the drawer (calls `admin_grant_credits` with a default amount the admin can edit).
- [ ] New inbound message flips inbox list row to bold/unread within 2 s via realtime.

---

## Phase 14 — Tab: Notifications

### 14.1 New schema
- [ ] `notification_templates (id, slug, title_template, body_template, cta_url_template, icon, severity, created_at, updated_at)`.
- [ ] `user_notifications (id, user_id, template_slug, title, body, cta_url, icon, severity, delivered_at, read_at, dismissed_at, scheduled_for, sent_by_admin_id, created_at)` per Phase 2.5.

### 14.2 New RPCs
- [ ] `admin_send_notification(p_user_ids uuid[], p_title text, p_body text, p_cta_url text, p_severity text)` — fan-out insert + audit log + realtime publish.
- [ ] `admin_send_notification_to_segment(p_segment text, ...)` — `segment ∈ {'all','plan:studio','plan:pro','plan:free','active_7d','inactive_30d','region:eu'}` — query that segment, fan out.
- [ ] `admin_schedule_notification(... p_scheduled_for timestamptz)` — inserts with `delivered_at IS NULL` and `scheduled_for` set.
- [ ] `mark_notification_read(p_id uuid)` / `dismiss_notification(p_id uuid)` — user-side.

### 14.3 Worker handler `handleScheduledNotifications`
- [ ] New worker handler picks up `user_notifications` where `scheduled_for <= now() AND delivered_at IS NULL`, sets `delivered_at = now()`, optionally fires email via Resend.
- [ ] Add task_type `notification.deliver` to `video_generation_jobs` enum.
- [ ] Cron-style: separate worker poll loop for notification deliveries; not tied to video pipeline.

### 14.4 KPI grid (4 tiles)
- [ ] `Unread alerts` — count of `user_notifications` for the admin's own id where `read_at IS NULL`.
- [ ] `Open incidents` — `count from incidents where status='open'`.
- [ ] `MTTR · 30d` — `avg(resolved_at - acknowledged_at)` last 30 d.
- [ ] `Alerts · 7d` — count of admin notifications in last 7 d, grouped by severity in sub-label.

### 14.5 Notification stream UI
- [ ] Filter chips: All / Unread / High / Medium / Low + `Mark all read`.
- [ ] List entries match design spec (icon tile color by severity, body title + description, ack pill, source mono row).
- [ ] Per-entry actions: Acknowledge (sets `read_at`), View (opens drawer/relevant tab), Snooze 1h (sets `scheduled_for = now()+1h` and `read_at = now()` to hide for now).

### 14.6 Notification routing
- [ ] Channels card — toggles persisted in `app_settings` (`notification_channels` jsonb). 5 channels: Slack `#ops-alerts`, PagerDuty oncall, Email digest, SMS, Discord.
- [ ] Routing rules card — list of rules from new table `notification_rules (id, name, condition_jsonb, action_jsonb, enabled, created_at, updated_at)`.
- [ ] `+ New rule` button opens a builder modal: when `severity = high AND src LIKE 'stripe.*'` then `Slack + PagerDuty`.
- [ ] Worker / edge fn checks rules at notification-emit time and dispatches.

### 14.7 Acceptance
- [ ] Sending to a segment delivers in <30 s for ≤ 1k users.
- [ ] Scheduled notification fires within 60 s of `scheduled_for`.
- [ ] Snooze 1h hides the row, reappears after the hour.

---

## Phase 15 — Tab: Newsletter

### 15.1 New schema
- [ ] `newsletter_campaigns` and `newsletter_sends` per Phase 2.5.
- [ ] `profiles.marketing_opt_in`, `profiles.newsletter_unsubscribed_at` (Phase 2.4).
- [ ] Public unsubscribe page route + RPC `unsubscribe_with_token(p_token text)` — token signed with HS256, embedded in newsletter footer link.

### 15.2 New RPCs
- [ ] `admin_create_campaign(p_subject, p_body_html, p_body_text, p_audience text)` — returns campaign id.
- [ ] `admin_send_test_to_self(p_campaign_id)` — sends a single email to the calling admin's address.
- [ ] `admin_schedule_campaign(p_campaign_id, p_scheduled_for timestamptz)`.
- [ ] `admin_cancel_campaign(p_campaign_id)` — only if status='scheduled' or 'sending' (latter pauses dispatcher; super_admin gate).

### 15.3 Worker handler `handleNewsletterSend`
- [ ] Polls `newsletter_campaigns` where `status='scheduled' AND scheduled_for <= now()`, claims the row by setting status='sending'.
- [ ] Generates `newsletter_sends` rows for each opted-in user matching the audience clause.
- [ ] Fans out to Resend with batching (1k recipients/batch).
- [ ] Updates `newsletter_sends.status` to 'sent' on success, 'failed' with error on failure.
- [ ] After all rows processed, sets campaign `status='sent', sent_at=now()`.

### 15.4 New edge function `resend-webhook`
- [ ] Validates Resend signature.
- [ ] Maps event types: `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, `email.delivered`.
- [ ] Updates `newsletter_sends` row by `resend_message_id`.

### 15.5 KPI grid (4 tiles)
- [ ] `Subscribers` — `count from profiles where marketing_opt_in = true and deleted_at is null`.
- [ ] `Last open rate` — `count(opened_at) / count(sent_at)` for most recent campaign.
- [ ] `Last click rate` — `count(clicked_at) / count(opened_at)` for most recent campaign.
- [ ] `Unsubs · last send` — count of users who unsubscribed within 24 h after the most recent campaign.

### 15.6 Composer UI (cols-1-2)
- [ ] Audience radio (4 options): All / Studio / Pro / Free. Recipient count auto-updates.
- [ ] Subject input + character counter (warn if >60).
- [ ] Headline input.
- [ ] Body textarea (rows=9). Markdown supported (parse to HTML before send).
- [ ] CTA fields: label input + URL input.
- [ ] Right column: Preview matching design (`#fafaf6` bg, `#1a1a1a` text, Georgia/Times serif).

### 15.7 Toolbar buttons
- [ ] `Save draft` — calls `admin_create_campaign` with `status='draft'`.
- [ ] `Send test → me` — calls `admin_send_test_to_self`.
- [ ] `Schedule send` — opens datetime picker → `admin_schedule_campaign`.

### 15.8 Recent campaigns table
- [ ] Columns: Campaign, Sent, Recipients, Open, Click, Unsubs, Status.
- [ ] Click row → opens detail drawer with full breakdown + ability to clone or resume (if cancelled).

### 15.9 Acceptance
- [ ] Test send arrives within 1 min in admin's inbox.
- [ ] 4k-recipient send completes in <10 min with no Resend rate-limit failures.
- [ ] Open/click rates match Resend dashboard within 5 min.
- [ ] Unsubscribe link in footer flips opt-in to false on click.

---

## Phase 16 — Tab: Announcements

### 16.1 New schema
- [ ] `announcements (id, title, body_md, severity, cta_label, cta_url, audience jsonb, starts_at, ends_at, active, created_by, created_at, updated_at)` per Phase 2.5.
- [ ] `announcement_dismissals (announcement_id, user_id, dismissed_at, PRIMARY KEY (announcement_id, user_id))`.

### 16.2 New RPCs
- [ ] `admin_create_announcement(p_title, p_body_md, p_severity, p_cta_label, p_cta_url, p_audience, p_starts_at, p_ends_at)`.
- [ ] `admin_update_announcement(p_id, ...)`.
- [ ] `admin_archive_announcement(p_id)` — sets `active=false, ends_at=now()`.
- [ ] `current_announcements_for_me() RETURNS SETOF announcements` — user-side; joins to `announcement_dismissals` to filter out dismissed; respects audience predicate.
- [ ] `dismiss_announcement(p_id uuid)` — user-side; inserts into `announcement_dismissals`.

### 16.3 KPI grid (4 tiles)
- [ ] `Active announcements` — `count where active and now() between starts_at and coalesce(ends_at, 'infinity')`.
- [ ] `Reach today` — sum of distinct user_ids who have NOT dismissed an active announcement and matched the audience clause.
- [ ] `CTA click rate` — needs CTA-click tracking (Phase 16.4).
- [ ] `Dismissed` — `count from announcement_dismissals where dismissed_at > now()-24h`.

### 16.4 CTA click tracking
- [ ] Wrap announcement CTA URLs through a redirect endpoint `/announce/click/:id?to=<url>` (new edge fn `announcement-click`) that logs to `announcement_clicks (announcement_id, user_id, clicked_at)` then 302s.

### 16.5 Composer UI (cols-1-2)
- [ ] Channel radio (5): banner / modal / toast / email / push. (Mapping: 'banner' shows site-wide; 'modal' is one-time on next visit; 'toast' is auto-dismiss; 'email' triggers a one-shot newsletter; 'push' fires `admin_send_notification_to_segment`.)
- [ ] Message textarea (rows=5). Markdown.
- [ ] CTA fields.
- [ ] Targeting chip group: All / Studio / Pro / Free / Active 7d / Inactive 30d / EU only. Active state persists.
- [ ] Right column preview, swap based on channel.

### 16.6 Toolbar
- [ ] `Schedule` → datetime picker for starts_at.
- [ ] `Publish now` → `admin_create_announcement` with `starts_at = now()`.

### 16.7 Live announcements section (cols-2)
- [ ] One card per active announcement.
- [ ] Card content: title + live pill, channel/audience/views/clicks grid, expires line, Edit / End now buttons.
- [ ] End now → `admin_archive_announcement`.

### 16.8 Front-end client integration
- [ ] On every authenticated route load, call `current_announcements_for_me()` and render the highest-severity active one as a banner/modal/toast (per its `body_md.channel_hint`).
- [ ] Top-banner component already exists for autopost; extend or generalize. Check `src/components/` for an existing announcement banner; if not, create `src/components/announcements/AnnouncementBanner.tsx`.
- [ ] Realtime subscription on `announcements` to insert/remove banners without reload.

### 16.9 Acceptance
- [ ] Publishing a banner shows up on a logged-in user's screen within 5 s.
- [ ] Dismissed announcements never re-appear for that user.
- [ ] Audience predicate excludes non-matching users (manual: create banner with `audience.plan='pro'`, verify free-plan user doesn't see).

---

## Phase 17 — Tab: Kill switches

### 17.1 RLS hardening
- [ ] Add admin SELECT on `feature_flags`. Writes stay RPC-only.
- [ ] New RPC `admin_set_feature_flag(p_flag text, p_enabled boolean, p_reason text)` — gated, audit-logged, writes `updated_by = (select email from auth.users where id = auth.uid())`.

### 17.2 Master kill switch
- [ ] Seed `app_settings` row:
  ```sql
  INSERT INTO public.app_settings (key, value)
  VALUES ('master_kill_switch', jsonb_build_object('enabled', false, 'message', null, 'set_by', null, 'set_at', null))
  ON CONFLICT DO NOTHING;
  ```
- [ ] Worker `index.ts`: every loop iteration, read `master_kill_switch`. When `enabled=true`, stop claiming new jobs and emit a system_log row (`event_type: 'master_kill.engaged'`).
- [ ] Edge functions check the flag at request time. When engaged, return 503 with a maintenance message except for `/admin/*` routes (those still work for super_admins).
- [ ] New RPC `admin_set_master_kill_switch(p_enabled boolean, p_message text)` — super_admin gated. Side effects: when transitioning false→true, calls `admin_cancel_all_active_jobs(true, 1, 'Master kill switch engaged: <message>')` and auto-creates an `announcements` row with severity='critical'.

### 17.3 Subsystem switches (8 cards)
- [ ] All 8 are `feature_flags` rows: `maint`, `signups_disabled`, `video_generation`, `image_generation`, `voice_generation`, `payments`, `autopost`, `newsletter`.
- [ ] Each card: icon tile, title, description, ARMED/idle pill. Toggle calls `admin_set_feature_flag`.
- [ ] Worker / edge fn checks the relevant flag at the right code path:
  - `signups_disabled` → checked in `handle_new_user` trigger.
  - `video_generation` → checked in `handleCinematicVideo`.
  - `image_generation` → checked in `imageGenerator.ts`.
  - `voice_generation` → checked in `audioRouter.ts`.
  - `payments` → checked in `create-checkout` edge fn.
  - `autopost` → checked in `autopost_tick()`.
  - `newsletter` → checked in `handleNewsletterSend`.
  - `maint` → checked in `Sidebar.tsx` (renders maintenance banner) + every edge fn entry.

### 17.4 Feature flags table
- [ ] Reuse the `feature_flags` table but expose via `admin_v_feature_flags` view that adds rollout %, audience description, active users count (joined from segment helpers).
- [ ] Columns: Flag · Description · Rollout · Audience · Active users · Updated · Action.
- [ ] Edit modal: name (read-only), description, rollout % slider (0–100), audience picker (all / plan / region / cohort), enabled toggle.
- [ ] Save calls `admin_set_feature_flag` + `admin_update_flag_metadata` (new RPC).

### 17.5 Realtime
- [ ] `feature_flags` and `app_settings` realtime publication so the worker observes flips within 2 s without polling.
- [ ] Admin UI mirrors the same realtime channels — when one admin flips a switch, the other admin's UI updates within 2 s.

### 17.6 Audit
- [ ] Every flip writes one `admin_logs` row with action `feature_flag.set`, target_type='feature_flag', target_id=`<flag_name>`, details `{ from, to, reason }`.

### 17.7 Acceptance
- [ ] Master kill engages within 5 s of toggle (verify worker stops claiming via Render logs).
- [ ] Disengage restores service immediately.
- [ ] Flipping `voice_generation` causes voice clone jobs to fail-fast with the right error message.
- [ ] Audit log row exists for every flip.

---

## Phase 18 — Quality gates

### 18.1 Responsive
- [ ] All admin pages render correctly at 360 / 768 / 1024 / 1440 px viewports.
- [ ] Sidebar collapses to top hamburger menu below 900 px (already in dashboard Sidebar — verify still works inside admin shell).
- [ ] Tab strip horizontal-scrolls on mobile, no wrap, scrollbar hidden.
- [ ] Drawer fills 100 vw on mobile.
- [ ] All `cols-2`/`cols-3` grids collapse to single column at 1100 px.
- [ ] KPI grid: 2 columns at 520 px, 1 column at 360 px.
- [ ] All inbox/console panes stack vertically on mobile.
- [ ] Tap targets ≥ 44 px on mobile (buttons, links, toggles).

### 18.2 Accessibility
- [ ] Every icon-only button has `aria-label` and `title`.
- [ ] Tab strip uses `role="tablist"` / `role="tab"` / `role="tabpanel"` with `aria-selected` and `aria-controls`.
- [ ] Drawer has `role="dialog"`, `aria-modal="true"`, focus trap, ESC closes, focus returns to trigger on close.
- [ ] All form inputs have associated `<label>` (currently only mono caption — augment with `<label htmlFor>`).
- [ ] Color contrast: ink-mute on panel-2 must hit WCAG AA (verify with axe-core; bump if needed).
- [ ] Status-conveying color always paired with text label (e.g. "high" pill is gold AND says "high"). Verify across all status pills.
- [ ] Keyboard navigation: Cmd+K opens command palette, ESC closes overlays, Tab moves through interactive elements in logical order.
- [ ] Screen-reader smoke test with macOS VoiceOver: hero, tab strip, KPI grid, drawer, console.
- [ ] Reduced motion: respect `prefers-reduced-motion` — disable bar transitions, hero pulse, drawer slide.

### 18.3 Performance
- [ ] Initial admin route bundle ≤ 250 KB gzipped (use `vite-bundle-visualizer`).
- [ ] Lazy-load every tab; cold-tab hit ≤ 80 KB gzipped per chunk.
- [ ] Sparkline + Donut SVG-based — no canvas, no chart lib by default. (Recharts only kept if existing tab needs it.)
- [ ] React Query: dedupe in-flight queries via `staleTime` and `gcTime` per Phase 0.4.
- [ ] Realtime channels limited to one per realtime-needing tab. Tear down on unmount.
- [ ] Console tab uses `react-virtual` (or `@tanstack/react-virtual`) to render only visible log rows. Buffer cap 500.
- [ ] All RPCs paginated server-side (limit/offset). Default page 50, max 200.
- [ ] Time-to-interactive on Overview tab ≤ 1.5 s p95 on a 4 G connection (Lighthouse).

### 18.4 Observability
- [ ] Sentry: every admin tab wraps in an `ErrorBoundary` that reports to Sentry with `tags: { tab: '<key>' }`.
- [ ] Every admin RPC call logs latency + outcome to `system_logs`.
- [ ] Sentry breadcrumb when an admin opens any tab (low PII).
- [ ] Realtime channel error → toast "Connection lost — retrying" + auto-reconnect.

### 18.5 Security
- [ ] Every `useAdminAuth` consumer revalidates is_admin on focus (already in place — verify).
- [ ] No service-role keys in client code. Audit `.env.production` and `vite.config.ts` for accidental exposure.
- [ ] CSRF: all POST routes via Supabase RPCs (service role + JWT); custom edge fns verify Authorization header is the user's JWT.
- [ ] Rate limit admin write RPCs (existing `rate_limits` table) to 60/min per admin.
- [ ] Plaintext API keys never round-trip through the client. (`admin_v_user_provider_keys` view + `admin_create_internal_key` returns plaintext exactly once at creation.)
- [ ] Newsletter unsubscribe tokens HS256-signed with a server-side secret in `app_settings.newsletter_unsubscribe_secret`.
- [ ] Super-admin role required for: hard-delete, master kill, force signout, cancel-newsletter-in-flight, drop announcement audience='all' severity='critical'.

### 18.6 Operational runbooks (in this repo `docs/admin/runbooks/`)
- [ ] `master-kill.md` — when to engage, how to disengage, what users see, comms templates.
- [ ] `incident-response.md` — error-spike playbook: read Errors tab, group by fingerprint, link to Sentry, create incident, comms.
- [ ] `revenue-reconciliation.md` — how to reconcile Stripe vs admin revenue, when to refund.
- [ ] `newsletter-send.md` — pre-flight checklist (subject lint, audience verify, test send), monitoring during send.
- [ ] `announcement-publish.md` — templates for maintenance windows, feature launches.
- [ ] `kill-switch-deploy.md` — how to add a new feature flag including worker + edge fn checkpoints.

---

## Phase 19 — Production verification

### 19.1 End-to-end smoke tests (e2e — playwright if available)
- [ ] Login as admin → Admin tab visible in sidebar.
- [ ] Click Admin → land on Overview, all 6 tiles render with non-zero data (assuming non-empty DB).
- [ ] Tab through all 15 tabs without console errors.
- [ ] Overview live activity receives a worker log within 5 s (kick a small generation, watch the feed).
- [ ] Users tab → search returns results, click a row opens drawer with all 5 sub-tabs.
- [ ] Generations tab → filter by 'failed', see real failed jobs.
- [ ] Performance tab → worker_heartbeats has at least one row.
- [ ] Errors tab → grouping works, resolve action persists.
- [ ] Console tab → live tail shows recent rows; pause/resume works; grep filters.
- [ ] Messages tab → reply lands in user's account + email arrives.
- [ ] Notifications tab → send to self → in-app notification appears.
- [ ] Newsletter tab → test send → email arrives in admin inbox.
- [ ] Announcements tab → publish banner → free-plan account sees it on next page load.
- [ ] Kill switches → flip `voice_generation` off → next voice job fails with the right error message; flip on → next voice job succeeds.

### 19.2 Backend verification
- [ ] All 15 new tables have RLS enabled (`SELECT relname FROM pg_class WHERE relrowsecurity = false AND relnamespace = 'public'::regnamespace AND relkind = 'r'` returns 0 rows for new tables).
- [ ] All cron schedules show in `cron.job` (verify via `SELECT * FROM cron.job`).
- [ ] All MVs refreshing on schedule (`SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20`).
- [ ] Realtime publication includes the 9 admin tables added (`SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`).
- [ ] No service-role keys leaked to client (grep `.env.local` and the built `dist/` for SUPABASE_SERVICE_ROLE_KEY).
- [ ] Sentry receives a synthetic error from an admin action.

### 19.3 Performance verification
- [ ] Lighthouse score on /admin ≥ 90 perf, ≥ 95 a11y.
- [ ] React Profiler: no tab renders with >5 ms commit time on data-set-sized payloads (use 1k users, 500 messages, 1k notifications).
- [ ] Realtime: Console can sustain 100 logs/sec for 60 s without dropping or freezing.

### 19.4 Mobile verification
- [ ] All 15 tabs render correctly at 360 px (manual + Chrome DevTools Pixel-7 emulation).
- [ ] Sidebar mobile menu opens/closes; all admin sub-links reachable.
- [ ] Drawer fullscreens at 360 px.
- [ ] No horizontal scroll on the body at any tab.

### 19.5 Security verification
- [ ] Non-admin user navigates to `/admin?tab=overview` → redirected to access-denied.
- [ ] Admin user without super_admin attempts `admin_set_master_kill_switch` → 42501 forbidden.
- [ ] CSV export endpoints require admin auth (manual: try unauthenticated curl, expect 401).
- [ ] User cannot read other users' threads (`SELECT * FROM admin_messages WHERE thread_id IN (SELECT id FROM admin_message_threads WHERE user_id <> auth.uid())` returns 0 rows for a normal user).

### 19.6 Audit log verification
- [ ] Every action in §19.1 wrote exactly one `admin_logs` row with the correct admin_id, action, target_id, and details.
- [ ] `admin_logs` rows include `request_id` for multi-step flows.

### 19.7 Documentation
- [ ] `docs/admin/README.md` describes the 15-tab structure, owners, escalation paths.
- [ ] Each new RPC documented with signature, gates, return shape.
- [ ] All new tables documented with column-level comments (`COMMENT ON COLUMN ...`).
- [ ] Migration index updated in `supabase/migrations/README.md` (if exists).

### 19.8 Sign-off
- [ ] Founder walkthrough on a real account (no demo data) — every tab loads, every action works, no surprises.
- [ ] Worker logs reviewed for any new error categories introduced by the rebuild.
- [ ] 24-hour soak test in production with real traffic — no regressions in /admin error budget vs. baseline.

---

## Implementation order recommendation

1. **Phase 0 + Phase 1.1–1.3** — foundations + sidebar integration + shell (no real data yet, mocked tabs).
2. **Phase 2** — backend infra (tables, RLS, realtime, cron, RPCs, MVs, worker emit-points). Critical path; everything else blocks here.
3. **Phase 3, 4, 5, 6, 8, 9, 10** — tabs that primarily reuse existing data (Overview / Analytics / Activity / API & Costs / Users / Generations / Performance).
4. **Phase 11, 12** — Errors + Console (need the system_logs schema additions from Phase 2.4).
5. **Phase 17** — Kill switches (depends on master_kill_switch row + feature flag RLS from Phase 2.7).
6. **Phase 13, 14, 15, 16** — net-new comms tabs (Messages, Notifications, Newsletter, Announcements). Each needs new tables + worker handlers + edge fns.
7. **Phase 7** — API Keys (last because it depends on internal-token middleware in worker + edge fns).
8. **Phase 18 + 19** — quality gates + verification.

Estimated workload: 6–10 weeks of focused engineering by one senior full-stack dev, or 3–4 weeks split across 2–3 devs working in parallel after Phase 2 lands.

---

## Out of scope (per founder's instruction)

- **Brand kits** — no surface, no nav link, no settings.
- **Sidebar fork** — reuse `src/components/dashboard/Sidebar.tsx` with `{isAdmin && ...}` block insertion only.
- **i18n in admin chrome** — defer; admin runs in en-US only.
- **Light theme for admin** — admin is dark-only.
- **Generic SaaS dashboard energy** — no card-fatigue stacks, no rounded-3xl rows, no italic display, no red, no green outside `--good` for status dots/sparks.

---

## Definition of "production-ready"

When every box above is ticked, the admin meets the bar set by the founder:

> "fully operational admin production ready, built up to standard, optimized and full operational"

This means:
1. Every tab reads from real data (no mocks).
2. Every admin action persists, audit-logs, and returns within 1 s p95.
3. Every kill switch reaches the worker in <5 s.
4. Every new table has RLS, RPC, realtime, audit, and a written runbook for the operator.
5. Every screen renders responsively from 360 px to 4K.
6. Mobile parity is real, not a degraded view.
7. Founder can run the entire business from `/admin` without opening Stripe, Supabase Studio, or a SQL client.
