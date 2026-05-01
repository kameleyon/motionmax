# Autopost — Production-Readiness Checklist

> Scope excludes social-media publishing (YouTube/Instagram/TikTok upload + OAuth + dispatcher). That work is gated behind Google verification and is intentionally out of scope here.

**Verdict: PRODUCTION-READY (email + library modes).**

> Social publishing remains gated behind Google verification (out of scope). OAuth-token-vault encryption is deferred until that ships. Daily-summary email transport, Slack/PagerDuty queue alerts, and metrics race-RPC are accepted nice-to-haves.

## Top 3 blockers — RESOLVED

1. ✅ **Kill switches now writable by admins.** Migration `20260502100000_app_settings_admin_write_policies.sql` adds UPDATE + INSERT policies on `public.app_settings` gated on `is_admin(auth.uid())`. AutopostHome's writeSwitch persists.
2. ✅ **Credit deduction wired into both SQL functions.** Migration `20260502110000_autopost_credit_deduction_and_empty_topic_guard.sql` adds `autopost_credits_required(mode, length)` and calls `deduct_credits_securely` inside `autopost_tick()` and `autopost_fire_now()` BEFORE inserting the render job. Insufficient balance marks the run failed with `error_summary='Insufficient credits'`. `payload.creditsDeducted` is stamped onto the render job. Worker `refundCreditsOnFailure` no-ops for `autopost_render` when `creditsDeducted` is missing/zero (no more phantom 280-credit refunds).
3. ✅ **Empty topic pool guarded.** Both functions skip with RAISE NOTICE when `topic IS NULL AND array_length(topic_pool, 1) = 0`. `autopost_fire_now` raises a user-visible exception instead of firing a topicless run.

---

## 1. Scheduling Correctness

| Item | Status | Notes |
|------|--------|-------|
| Cron parsing + DST handling | ✅ | `autopost_advance_next_fire` parses 5-field cron with comma-lists, ranges, steps, Sunday-7 normalization, in-UTC iteration with local-time field matching. |
| `next_fire_at` advancement (no catch-up storm) | ✅ | `autopost_tick` uses `GREATEST(next_fire_at, NOW())` (migration `20260429170000_autopost_tick_no_catchup.sql`). Frontend toggle re-anchors via `nextFireFromCron`. |
| Pause/unpause | ✅ | `UpdateScheduleDialog` + `_AutomationCard` toggle. Tick `WHERE active = TRUE` gate prevents fires during pause. |
| Kill-switch flag (global + per-platform) | ✅ | Migration `20260502100000` adds admin UPDATE/INSERT policies on `app_settings`. |
| Empty topic pool guard | ✅ | Both `autopost_tick()` and `autopost_fire_now()` skip with RAISE NOTICE; `fire_now` raises a user-visible error (migration `20260502110000`). |
| DB-level re-anchor on `active=true` flip | ✅ | `autopost_schedules_reanchor_trg` BEFORE UPDATE trigger pushes a stale `next_fire_at` strictly into the future via `autopost_advance_next_fire` (migration `20260502120000`). |

---

## 2. Topic Generation

| Item | Status | Notes |
|------|--------|-------|
| Initial generation (intake form) | ✅ | `handleGenerateTopics` + Gemini `googleSearch`, 1.5s polling, 120s timeout. |
| Regenerate (more topics) | ✅ | `GenerateTopicsDialog` passes `existingTopics` for dedup. |
| Format consistency | ✅ | Worker injects FORMAT CONSISTENCY block when `existingTopics` are present. |
| Exclusion list | ✅ | Capped at 60 most-recent. |
| Source attachments | ✅ | `processAttachments` runs before enqueue. |
| `excludedCount` persistence across dialog opens | ✅ | Skipped topics stored in `config_snapshot.skipped_topics` (deduped) on save; counter rehydrates on dialog open. |
| `generate_topics` job row cleanup | ✅ | `cleanup_old_generate_topics_jobs()` SECURITY DEFINER function + pg_cron registration (`autopost-generate-topics-cleanup`, daily 03:15 UTC). Migration `20260502120000`. |

---

## 3. Render Pipeline

| Item | Status | Notes |
|------|--------|-------|
| Orchestrator resilience | ✅ | `handleAutopostRun` catches all errors → `markRunFailed` → re-throws. |
| Worker-restart recovery | ✅ | Dispatcher resets stale `uploading` rows; `autopost_render` job sits as a regular `video_generation_jobs` row. |
| Dependency-chain failure handling | ✅ | `waitForJob` throws on `failed` status; em-dash unwrap surfaces leaf cause. |
| Kling/Hypereal moderation surface | ✅ | "Failure to pass the risk control system" reaches `error_summary`. |
| Per-phase hard timeouts | ✅ | Script 8m, phase 30m, export 15m. |
| Stall watchdog | ✅ | 3 h hard ceiling + 30 min heartbeat-silence check. |
| Outer absolute timeout on `autopost_render` job | ✅ | `getJobTimeoutMs("autopost_render")` returns `AUTOPOST_JOB_TIMEOUT_MS` (3.5 h, env-overridable). Existing `Promise.race(processJob, setTimeout(reject))` in `pollQueue` enforces it. |
| Per-scene fallback for Kling rejection | ❌ | blocked: deferred — requires per-scene retry/fallback policy that is out of scope for this ship. |

---

## 4. Email Delivery

| Item | Status | Notes |
|------|--------|-------|
| Resend integration | ✅ | API key + verified `motionmax.io` from-address. |
| Recipient validation | ✅ | Regex on intake + edit dialog; server-side check for empty recipients. |
| Branded URLs | ✅ | Watch CTA → `motionmax.io/lab/autopost/runs/<id>`. |
| Thumbnail in email | ✅ | `handleAutopostRun` awaits thumbnail before returning so `thumbnail_url` is set before trigger fires. |
| `RESEND_FROM_EMAIL` startup validation | ✅ | If missing or still `onboarding@resend.dev`, the handler writes a `system_warning` (`autopost_email_misconfigured_from`) on every send. |
| Per-recipient retry on Resend failure | ✅ | 3-attempt exponential backoff (1s, 2s, 4s) on transport errors + 5xx + 429. Permanent 4xx bails after the first attempt. |
| Email failure surfaced in Run Detail | ✅ | All `writeSystemLog` calls in `handleEmailDelivery.ts` now carry `details.autopost_run_id`, so RunDetail's filter (`details->>autopost_run_id`) picks them up. |

---

## 5. Library Mode

| Item | Status | Notes |
|------|--------|-------|
| Run history rendering + filters | ✅ | Status / schedule / platform / date filters. Day-bucket grouping. Realtime updates. |
| Deletion + RLS + cascade | ✅ | `admins delete runs of own schedules` policy + `ON DELETE CASCADE` on publish_jobs. |
| Run detail (watch / download / open in editor) | ✅ | `finalUrl` + `projectId` resolved from render-job result. |
| Thumbnail freshness | ✅ | Generated once, public bucket URL. |
| Stale-run cleanup for `queued` (not just `generating`) | ✅ | `cleanupStalledRuns` extended: `queued` runs older than `STALLED_QUEUED_RUN_MS` (2 h) with no matching `video_generation_jobs` row are flagged failed. |
| Pagination | ✅ | `range(from, to)` + accumulator state in `RunHistory.tsx`; "Load more" fetches one page at a time, dedupes by id. |

---

## 6. UX / UI

| Item | Status | Notes |
|------|--------|-------|
| Intake schedule toggle | ✅ | Frequency, topics, delivery, terms — full flow. |
| Automation card actions | ✅ | Run-now, edit, generate topics, schedule, pause/resume, delete. |
| Edit Automation dialog | ✅ | Name, prompt, delivery, recipients, resolution, language, voice, captions. |
| Run-history list density | ✅ | ~48px rows, status pill, platform pills, progress, error expander. |
| Run detail page | ✅ | Header, prompt, log feed, per-platform timeline. |
| Real-time progress % | ✅ | `progress_pct` waypoints + realtime subscription. |
| `UpdateScheduleDialog` credit estimate | ✅ | Uses `getCreditsRequired(mode, length)` from `config_snapshot` instead of stale `duration_seconds`. |
| `estimateCredits()` accuracy | ✅ | `_AutomationCard.estimateCredits` now calls `getCreditsRequired(mode, length)` (the same helper IntakeForm/CreditEstimate use). |
| RunDetail log panel populated | ✅ | `handleAutopostRun.ts` writes `autopost_run_id` into `details` at every milestone (start, script queued/done, audio queued, finalize done, export done, thumbnail success/fail, complete, failed). |

---

## 7. DB / RLS / Security

| Item | Status | Notes |
|------|--------|-------|
| Admin gate (`is_admin(auth.uid())` everywhere) | ✅ | All four autopost tables. |
| Ownership policies | ✅ | RUN/JOB rows joined to `autopost_schedules.user_id`. |
| `SECURITY DEFINER` with `search_path` | ✅ | `autopost_tick`, `autopost_fire_now`. |
| Service-role not exposed in browser | ✅ | All writes go through admin-gated policies or RPCs. |
| FK cascade chain | ✅ | schedules→runs→publish_jobs all cascade. |
| `app_settings` write policy for authenticated admin | ✅ | Migration `20260502100000_app_settings_admin_write_policies.sql` adds UPDATE + INSERT, idempotent. |
| OAuth token encryption (Supabase Vault) | ⚠️ | blocked: deferred — explicitly out of scope per ship plan; required only when social publishing comes off the gate. |

---

## 8. Observability

| Item | Status | Notes |
|------|--------|-------|
| `system_logs` per-phase coverage | ✅ | Render start/complete, thumbnail, email start/per-recipient/complete, dispatcher events. |
| `error_summary` user-friendly | ✅ | Em-dash unwrap surfaces leaf cause. |
| Queue-depth alerts to operator channel | ⚠️ | blocked: deferred nice-to-have — `ALERT_WEBHOOK_URL` already supported in `worker/src/index.ts`; routing decision (Slack vs PagerDuty) is ops-side. |
| Daily summary email | ⚠️ | blocked: deferred nice-to-have — log-only stays. |
| RunDetail log panel populated | ✅ | (See §6.) |
| Metrics race-free updates | ⚠️ | blocked: deferred nice-to-have — read-modify-write in `recordPublishOutcome` accepted for v1; no observed impact at current scale. |

---

## 9. Cost & Quotas

| Item | Status | Notes |
|------|--------|-------|
| Credit deduction at run kickoff | ✅ | `autopost_tick` + `autopost_fire_now` both call `deduct_credits_securely` with idempotency key `autopost_run:<run_id>` before enqueueing the render job. Migration `20260502110000`. |
| Refund logic correctness for `autopost_render` | ✅ | `refundCreditsOnFailure` no-ops for `autopost_render` when `payload.creditsDeducted` is missing/zero. When present, refunds the exact stamped amount via `refund_credits_securely`. |
| Pre-fire balance check | ✅ | Combined into the deduction step: `deduct_credits_securely` returns FALSE on insufficient balance → run is marked failed with `error_summary='Insufficient credits'`, render job is NOT inserted, error surfaces in run history (RunHistory shows error_summary on the row). |

---

## 10. Edge Cases & Resilience

| Item | Status | Notes |
|------|--------|-------|
| Deleted schedule mid-fire | ✅ | Cascade deletes the run row gracefully; trigger handles missing rows. |
| FK cascade on user delete | ✅ | Verified: schedules → runs → publish_jobs → social_accounts. |
| Empty topic pool guard | ✅ | (Same as §1.) |
| Pre-`config_snapshot` schedule fallback | ✅ | One-shot backfill in migration `20260502120000` populates `config_snapshot` for any row where it was NULL, copying live columns + the smartflow/short defaults. |
| Mid-flight env var rotation | ✅ | `process.env` read at call time. |

---

## Essential Files

- `worker/src/handlers/autopost/handleAutopostRun.ts`
- `worker/src/handlers/autopost/dispatcher.ts`
- `worker/src/handlers/autopost/handleEmailDelivery.ts`
- `worker/src/handlers/autopost/thumbnails.ts`
- `worker/src/handlers/autopost/retryPolicy.ts`
- `worker/src/handlers/handleGenerateTopics.ts`
- `worker/src/index.ts`
- `supabase/migrations/20260428120000_autopost_schema.sql`
- `supabase/migrations/20260428130000_autopost_tick_and_triggers.sql`
- `supabase/migrations/20260429150000_autopost_fire_now_rpc.sql`
- `supabase/migrations/20260429170000_autopost_tick_no_catchup.sql`
- `src/pages/lab/autopost/AutopostHome.tsx`
- `src/pages/lab/autopost/_AutomationCard.tsx`
- `src/pages/lab/autopost/RunDetail.tsx`
- `src/pages/lab/autopost/RunHistory.tsx`
- `src/components/intake/ScheduleBlock.tsx`
