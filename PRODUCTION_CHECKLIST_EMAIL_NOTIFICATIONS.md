# Email + In-App Notification + Newsletter — Production-Readiness Checklist

**Verdict (transactional only): NOT production-ready.**
**Verdict (newsletter / broadcast): NOT production-ready (0% built).**

## Top 3 blockers (transactional)

1. **Stripe-triggered emails fail silently.** `_shared/resend.ts` swallows missing-key errors with a `console.warn`. A misconfigured Supabase secret silently drops every welcome / payment-failed / cancellation email. Stripe never retries; the operator never knows.
2. **Stripe email templates are unstyled.** Bare `<h2>` / `<p>` HTML, no brand identity, no physical address (CAN-SPAM §7(a)(5) violation), no plain-text part (spam-filter risk). These go to paying customers — they must meet a minimum quality bar.
3. **No retry, no suppression list, no Resend message-ID capture.** A transient Resend outage drops critical email. Hard-bounced addresses are tried on every autopost run. Post-hoc delivery investigation is impossible because we never store the Resend message ID.

## Top 3 blockers (newsletter / broadcast)

1. **Zero implementation exists.** No admin compose UI, no recipient-list query, no broadcast send function.
2. **No opt-in consent.** No `marketing_email_opt_in` column on `profiles` — sending marketing email today is a GDPR Art. 6(1)(a) and CAN-SPAM violation.
3. **No deliverability monitoring.** No Resend webhook for bounce/complaint events; a bad broadcast can take down the whole Resend account and break transactional email.

---

## 1. Transactional Email Plumbing

| Item | Status | Notes |
|------|--------|-------|
| Resend API key as env var | ✅ | Read in both Edge Function (`_shared/resend.ts`) and worker (`handleEmailDelivery.ts`). |
| Verified sender domain | ⚠️ | `motionmax.io` works in Edge Function path. Worker falls back to `onboarding@resend.dev` if `RESEND_FROM_EMAIL` unset. `RESEND_FROM_EMAIL` and `APP_URL` missing from `worker/.env.example`. Effort: 1 h. |
| Hard-fail vs silent-drop on missing key | ⚠️ | Worker throws; Edge Function only `console.warn`s. Stripe webhook 200s back to Stripe even when emails dropped. File: `_shared/resend.ts` line 12-14. Effort: 1-2 h. |
| Retry on transient Resend errors | ❌ | No retry anywhere. Single network blip = lost email. Effort: 4-6 h exponential backoff wrapper. |
| Suppression list / hard-bounce handling | ❌ | No webhook receiver, no suppressed-emails table, no pre-send check. Effort: 8-12 h (Resend webhook + DB + check). |
| Resend `Idempotency-Key` header | ❌ | Job retries can produce duplicate sends. File: `handleEmailDelivery.ts` fetch body. Effort: 1 h. |
| Per-user/per-day rate limit | ❌ | Compromised schedule could spam thousands. Effort: 3-4 h. |

---

## 2. Email Templates / Design System

| Item | Status | Notes |
|------|--------|-------|
| Autopost video-ready email — branded, inline-styled, responsive | ✅ | Hand-authored HTML w/ dark bg, brand palette, table-button, plain-text fallback. |
| Stripe emails — styled / branded | ❌ | Bare `<h2>` / `<p>` in `_shared/resend.ts` lines 36-68. No styling, no logo, no responsive wrap, no mailing address, no dark-mode media query. Effort: 4-6 h. |
| Shared reusable email layout | ❌ | Every email type defines its own HTML. Effort: 6-8 h to extract. |
| Dark/light mode + mobile-tested | ⚠️ | Autopost is dark-only — no light-mode `@media`. No Litmus / Email-on-Acid evidence. Effort: 3-4 h. |
| Plain-text fallback on every send | ⚠️ | Autopost has it; Stripe emails don't. File: `_shared/resend.ts`. Effort: 1 h. |

---

## 3. Notification Preferences

| Item | Status | Notes |
|------|--------|-------|
| Per-user email opt-out per category | ❌ | No `email_preferences` column on `profiles`. No "Notifications" tab in Settings. Effort: 6-10 h. |
| Server-side honoring of preferences | ❌ | No send path checks any preferences. Effort: 3-4 h after schema. |
| Daily summary opt-out | ❌ | Stub explicitly skips email transport; no opt-out either. Effort: 2 h after schema. |

---

## 4. In-App Notifications

| Item | Status | Notes |
|------|--------|-------|
| Dedicated `notifications` table | ❌ | `NotificationsPopover` reads from `generations` table directly. Only generation-complete events surface. |
| Realtime delivery | ✅ | Supabase Realtime on `generations` for the current user. |
| Unread count badge | ✅ | Computed against localStorage timestamp. |
| Mark-as-read persistence | ⚠️ | localStorage only — resets per device / browser. Effort: 3-5 h `notifications_seen_at` server-side. |
| Archive / dismiss individual notifications | ❌ | Effort dependent on dedicated table (see top). |
| Non-generation system events | ❌ | No path to insert "schedule paused" / "payment failed" / etc. into the inbox. Effort: 10-16 h end-to-end. |

---

## 5. Compliance

| Item | Status | Notes |
|------|--------|-------|
| Transactional email exempt from unsubscribe mandate | ✅ | CAN-SPAM §1037 / GDPR recital 47. |
| Physical address in footer (CAN-SPAM §7(a)(5)) | ❌ | Missing from all four templates. Effort: 1 h. |
| GDPR data export (Art. 20) | ✅ | `export-my-data` edge function w/ rate limit. |
| GDPR right to erasure (Art. 17) | ✅ | `delete-account` edge function + 7-day grace + nightly drain. |
| Privacy policy + terms with re-consent on version bump | ✅ | `accepted_policy_version` on `profiles`. |
| Unsubscribe / `List-Unsubscribe` for autopost delivery email | ❌ | Today autopost email is arguably transactional. Once marketed as a feature, Gmail/Yahoo bulk-sender rules (Feb 2024) require List-Unsubscribe. Effort: 8-12 h. |
| Marketing-email opt-in consent recorded | ❌ | No column on `profiles`. Required before any non-transactional send. Effort: 2 h column. |

---

## 6. Newsletter / Broadcast Email

**0% implemented.** The daily summary in `dailySummary.ts` is the closest analog and even it explicitly skips the email transport.

| Item | Status |
|------|--------|
| Admin compose UI | ❌ |
| Recipient list query / segmentation | ❌ |
| Scheduled send / throttled dispatch | ❌ |
| Opt-in / opt-out plumbing | ❌ |
| Deliverability monitoring (open / bounce / complaint) | ❌ |

---

## 7. Operational Logging / Observability

| Item | Status | Notes |
|------|--------|-------|
| Every send logged to `system_logs` | ⚠️ | Autopost path: yes. Stripe path: only `console.error` — not persisted. Effort: 2-3 h. |
| Admin dashboard for send volume / bounce rate | ❌ | No email-specific view in `AdminLogs`. Effort: 6-8 h. |
| Resend message ID captured on success | ❌ | Response `id` is never read. Effort: 1-2 h. |
| Structured logging to aggregator | ✅ | JSON to stdout (Render) + Sentry. |

---

## 8. Edge Cases

| Item | Status | Notes |
|------|--------|-------|
| Email to deleted user | ⚠️ | Reads recipients from schedule's frozen array; soft-deleted user still receives. Effort: 2 h. |
| Email to past_due / cancelled subscription | ❌ | No subscription gate. Effort: 1-2 h. |
| Hard-bounced address | ❌ | (See §1 suppression-list gap.) |
| Deduplication of `autopost_email_delivery` job | ⚠️ | No unique constraint on `(autopost_run_id, task_type)`. Effort: 2 h migration. |
| Partial-batch send | ✅ | Handler catches per-recipient errors and continues. |
| Daily summary email transport | ⚠️ | Body string is ready; transport not wired. Effort: 3 h. |

---

## Essential Files

- `supabase/functions/_shared/resend.ts` — Edge Function Resend helper
- `worker/src/handlers/autopost/handleEmailDelivery.ts` — autopost video-ready email
- `supabase/functions/stripe-webhook/index.ts` — billing-email entry point
- `worker/src/handlers/autopost/dailySummary.ts` — body generator (no transport)
- `worker/src/lib/logger.ts` — `writeSystemLog` / `writeApiLog`
- `src/components/dashboard/NotificationsPopover.tsx` — entire in-app notifications surface
- `supabase/migrations/20260428170000_autopost_delivery_method.sql` — trigger that queues email job
- `supabase/migrations/20260201233354_*.sql` — `system_logs` schema
- `supabase/migrations/20260111215156_*.sql` — `profiles` schema (no email-pref columns)
- `worker/.env.example` — missing `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `APP_URL`
