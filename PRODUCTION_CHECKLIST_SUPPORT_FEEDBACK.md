# Support / Feedback / Bug-Report — Production-Readiness Checklist

**Verdict: NOT production-ready.**

## Top 3 blockers

1. **No structured feedback path exists.** Users have only a raw `mailto:` link in `HelpPopover`. On the modern web, many users have no default mail client → submissions are silently lost. Customer pain signals are invisible to the team.
2. **No storage / routing layer.** Even if the mailto works, there's no ticket table, no ticket reference, no acknowledgement to the user, and no admin inbox to triage from.
3. **Sentry Feedback integration referenced but never registered.** `GlobalErrorBoundary.tsx:94-96` calls `getIntegrationByName("Feedback")`, but `src/lib/sentry.ts` never adds `Sentry.feedbackIntegration()`. The crash-screen "Send feedback" button always falls back to `mailto:`.

---

## Minimum-Viable Build (ship these 5 first, ~14-16 h)

1. **DB migration** — `supabase/migrations/20260430000001_create_feedback_table.sql` w/ `feedback` table + RLS. (2 h)
2. **Edge function** — `supabase/functions/submit-feedback/index.ts`: validate, write row, send Resend ack to user + notification to support team. (4 h)
3. **`FeedbackModal.tsx`** — category + title + description + optional screenshot, auto-captured URL/UA, consent footnote, inline FAQ deflection. (4 h)
4. **Wire entry point** — add menu item to `HelpPopover`, register `Sentry.feedbackIntegration()`, register `Shift+?` shortcut. (2 h)
5. **Admin support tab** — `AdminSupport.tsx` table + side panel + mark-resolved. (4-6 h)

After MVB: Instatus status page (30 min), Privacy Policy update (30 min), reply threading (6-8 h), `/help` page (4 h).

**Total full-feature effort: 28-41 h.**

---

## Today's Inventory

**Partial / exists:**
- `src/components/dashboard/HelpPopover.tsx` — `?` icon in topbar with mailto:support link (no form)
- `src/components/landing/LandingFooter.tsx` — mailto in footer (public pages only)
- `src/components/pricing/EnterpriseContactModal.tsx` — sales form that opens `mailto:` (no API write)
- `src/components/landing/FaqSection.tsx` + `src/config/landingContent.ts` — public landing FAQ accordion
- `src/components/GlobalErrorBoundary.tsx` — broken Sentry-feedback button on crash screen
- `src/lib/sentry.ts` — initialized but `feedbackIntegration` never registered
- `supabase/functions/_shared/resend.ts` — Resend wired (transactional emails); no feedback templates
- `supabase/functions/_shared/rateLimit.ts` — DB-backed limiter; not yet wired to feedback

**Missing entirely:**
- No `feedback` / `support_tickets` / `bug_reports` table in any migration
- No `submit-feedback` edge function
- No persistent in-app feedback button (outside crash screen)
- No Slack/Discord/Linear webhook integration
- No admin triage inbox
- No reply / threading
- No in-app help center (FAQ exists only on landing)
- No `/status` route or external status page
- No captcha / abuse control on feedback paths
- No consent copy at submission time

---

## 1. User-Facing Entry Points

| Item | Status | Notes |
|------|--------|-------|
| `?` help button on every authed page | ✅ | `HelpPopover` in `AppShell` topbar. |
| `mailto:support@motionmax.io` in HelpPopover | ✅ | `HelpPopover.tsx:71`. |
| Footer contact email (landing) | ✅ | Landing footer only. |
| In-app feedback button during normal use | ❌ | `src/components/dashboard/AppShell.tsx` + new `FeedbackModal.tsx`. Effort: 3-4 h. |
| Keyboard shortcut to open feedback | ❌ | Register `Shift+?` in `AppShell`. |
| Support widget / chat | ❌ | Not recommended for MVP. |
| In-app footer contact link (authed) | ❌ | `LandingFooter` only renders on public pages. |

---

## 2. Submission Form

| Item | Status | Notes |
|------|--------|-------|
| Category selector (bug / feature / billing / other) | ❌ | New `FeedbackModal.tsx`. |
| Required title field | ❌ | |
| Required description | ⚠️ | `EnterpriseContactModal` has it but routes to mailto. |
| Optional screenshot attachment | ❌ | |
| Auto-captured browser + OS | ❌ | |
| Auto-captured page URL | ❌ | |
| Console-error capture (Sentry event ID) | ⚠️ | Sentry captures auto; user-triggered "attach logs" not wired. Effort: 4-6 h modal + auto-capture. |

---

## 3. Storage

```sql
create type feedback_category as enum ('bug','feature_request','billing','other');
create type feedback_status   as enum ('new','in_progress','resolved','closed');

create table feedback (
  id              uuid primary key default gen_random_uuid(),
  ticket_ref      text unique not null default 'MM-' || upper(substr(gen_random_uuid()::text, 1, 8)),
  user_id         uuid references auth.users(id) on delete set null,
  user_email      text,
  category        feedback_category not null default 'other',
  title           text not null check (char_length(title) <= 120),
  description     text not null check (char_length(description) <= 2000),
  page_url        text,
  user_agent      text,
  sentry_event_id text,
  screenshot_path text,
  status          feedback_status not null default 'new',
  assigned_to     text,
  admin_notes     text,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table feedback enable row level security;
create policy "users_own_feedback"  on feedback for select using (user_id = auth.uid());
create policy "users_insert"        on feedback for insert with check (user_id = auth.uid());
create policy "admin_all"           on feedback for all using (
  exists (select 1 from profiles where user_id = auth.uid() and is_admin = true)
);
```

| Item | Status |
|------|--------|
| `feedback` table + RLS | ❌ |
| Status enum + ticket reference | ❌ |
| Screenshot storage bucket (`feedback-screenshots`, private, 5 MB cap, image/* only) | ❌ |

Effort: 2 h.

---

## 4. Notification Routing

| Item | Status | Notes |
|------|--------|-------|
| Email to `support@motionmax.io` on submission | ❌ | New `sendFeedbackNotification` in `_shared/resend.ts`. |
| Auto-ack to user with ticket ref | ❌ | New `sendFeedbackAck`. |
| Slack / Discord webhook | ❌ | Free Slack incoming webhook → `#support-inbox`. Add `SUPPORT_SLACK_WEBHOOK_URL` Supabase secret. |
| CC developer | ❌ | Add to support template. |

Effort: 3-4 h.

---

## 5. Admin Triage UI

| Item | Status | Notes |
|------|--------|-------|
| Admin tab listing submissions | ❌ | New `src/components/admin/AdminSupport.tsx`; wire into `src/pages/Admin.tsx` `NAV_GROUPS`. |
| Filters: status / category / date | ❌ | |
| Assign-to | ❌ | |
| Reply-to-user | ❌ | (Phase 2.) |
| Mark-resolved | ❌ | |
| Age / SLA color-coding (>48h red) | ❌ | |

Effort: 6-8 h.

---

## 6. Reply / Threading

| Item | Status |
|------|--------|
| `feedback_replies` table + RLS | ❌ |
| Admin reply edge function | ❌ |
| Email notification of reply to user | ❌ |
| In-app notification of reply | ❌ |

Phase 1 (email-only): 4 h. Phase 2 (in-app threaded): 6-8 h.

---

## 7. Self-Service / Docs

| Item | Status | Notes |
|------|--------|-------|
| Inline FAQ deflection in `FeedbackModal` | ❌ | Top-5 from `LANDING_FAQ` w/ "None of these — continue" link. Effort: 1 h. Big ticket-volume reducer. |
| `/help` route w/ searchable FAQ | ❌ | New `src/pages/Help.tsx` + `helpContent.ts`. Effort: 4 h. |
| External docs (Mintlify / GitBook / Notion) | ❌ | Recommended: Mintlify free tier, integrates w/ GitHub repo. |

---

## 8. Rate-Limit / Abuse

| Item | Status | Notes |
|------|--------|-------|
| Per-user-per-day cap | ❌ | Wire existing `checkRateLimit({ key:'submit-feedback', maxRequests:10, windowSeconds:86400 })`. Effort: 1-2 h. |
| CAPTCHA for unauthed | ❌ | Low priority — feedback is auth-gated today. |
| Profanity filter | ❌ | Skip for MVP. |
| Spam blocker | ❌ | Skip for MVP — `is_spam` boolean for later flagging. |

---

## 9. Privacy

| Item | Status | Notes |
|------|--------|-------|
| Consent footnote at submission | ❌ | "By submitting, you agree the support team may read this report. Do not include passwords / payment / sensitive PII. See Privacy Policy." Effort: 0.5 h. |
| Sentry scrubs PII keys | ✅ | `beforeSend` strips password / token / key / secret. |
| Sentry scrubs PII values (e.g., card-number patterns in user text) | ⚠️ | Field VALUES not scrubbed. Strip CC pattern in edge function. Effort: 0.5 h. |
| Privacy Policy mentions feedback data | ❌ | Update `src/pages/Privacy.tsx` Section 2. Effort: 0.5 h. |

---

## 10. Public Status Page

| Item | Status | Notes |
|------|--------|-------|
| `/status` route or subdomain | ❌ | Recommended: **Instatus** (free tier, custom domain, REST API). Setup ~30 min. Add link to `HelpPopover` + `LandingFooter`. |
| Current incident display | ❌ | Provided by Instatus / BetterUptime. |
| Planned maintenance | ❌ | Provided by status page. |

Effort: 30 min Instatus setup; 4-6 h DIY status page.

---

## Summary Effort Table

| # | Section | Status | Effort | Recommended Tool |
|---|---------|--------|--------|------------------|
| 1 | User-facing entry points | ⚠️ | 3-4 h | Extend HelpPopover |
| 2 | Submission form | ❌ | 4-6 h | New `FeedbackModal.tsx` |
| 3 | Storage | ❌ | 2 h | Supabase migration |
| 4 | Notification routing | ❌ | 3-4 h | Resend (already wired) + Slack webhook |
| 5 | Admin triage UI | ❌ | 6-8 h | New `AdminSupport.tsx` |
| 6 | Reply / threading | ❌ | 6-8 h | Edge function + Resend |
| 7 | Self-service / docs | ⚠️ | 1-4 h | Inline deflection + Mintlify |
| 8 | Rate-limit / abuse | ⚠️ | 1-2 h | Wire existing `checkRateLimit` |
| 9 | Privacy | ⚠️ | 1-2 h | Consent copy + Privacy update |
| 10 | Status page | ❌ | 0.5 h | Instatus free tier |

**Total: 28-41 h.**

---

## Files To Create

- `src/components/modals/FeedbackModal.tsx`
- `src/components/admin/AdminSupport.tsx`
- `src/pages/Help.tsx`
- `src/config/helpContent.ts`
- `supabase/functions/submit-feedback/index.ts`
- `supabase/functions/reply-to-feedback/index.ts`
- `supabase/migrations/YYYYMMDD_create_feedback_table.sql`
- `supabase/migrations/YYYYMMDD_create_feedback_replies_table.sql`

## Files To Modify

- `src/components/dashboard/HelpPopover.tsx` — add "Send feedback / report issue" menu item
- `src/components/dashboard/AppShell.tsx` — register feedback modal state + `Shift+?` shortcut
- `src/lib/sentry.ts` — register `Sentry.feedbackIntegration({ autoInject: false })`
- `src/components/GlobalErrorBoundary.tsx` — verify the integration call now resolves
- `supabase/functions/_shared/resend.ts` — add `sendFeedbackNotification` + `sendFeedbackAck`
- `src/pages/Admin.tsx` — add "Support" tab
- `src/pages/Privacy.tsx` — add support-data section
- `src/components/landing/LandingFooter.tsx` — add status-page link
