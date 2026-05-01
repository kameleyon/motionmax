# Autopost — Production-Readiness Checklist

> Scope excludes social-media publishing (YouTube/Instagram/TikTok upload + OAuth + dispatcher). That work is gated behind Google verification and is intentionally out of scope here.

**Verdict: NOT production-ready.**

## Top 3 blockers

1. **Kill switches are silently broken.** `app_settings` has no `authenticated`-write RLS policy. Every admin click on the master / per-platform kill switch in `AutopostHome.writeSwitch()` shows a success toast but writes nothing to DB. (Fix: 0.5 h migration adding the missing policy.)
2. **Credit deduction never fires for autopost runs.** Both `autopost_tick()` and `autopost_fire_now()` insert render jobs without deducting credits. On success the user is never charged; on failure the broken refund logic refunds 280 phantom credits from a zero-deduction basis. (Fix: 4–6 h to wire deduction in both SQL functions and fix the refund guard.)
3. **Empty topic pool burns credits silently.** The "Out of topics" pill on the automation card is cosmetic only. `autopost_tick` and `autopost_fire_now` happily fire when `topic_pool = '{}'`, producing topicless videos every interval. (Fix: 1 h guard in both functions.)

---

## 1. Scheduling Correctness

| Item | Status | Notes |
|------|--------|-------|
| Cron parsing + DST handling | ✅ | `autopost_advance_next_fire` parses 5-field cron with comma-lists, ranges, steps, Sunday-7 normalization, in-UTC iteration with local-time field matching. |
| `next_fire_at` advancement (no catch-up storm) | ✅ | `autopost_tick` uses `GREATEST(next_fire_at, NOW())` (migration `20260429170000_autopost_tick_no_catchup.sql`). Frontend toggle re-anchors via `nextFireFromCron`. |
| Pause/unpause | ✅ | `UpdateScheduleDialog` + `_AutomationCard` toggle. Tick `WHERE active = TRUE` gate prevents fires during pause. |
| Kill-switch flag (global + per-platform) | ✅ logic / ❌ DB write blocked | Function reads the flag; UI cannot persist a change. |
| Empty topic pool guard | ❌ | `autopost_resolve_topic` returns NULL → run fires with `{topic}` → "" → topicless video, every interval. Files: `supabase/migrations/20260428130000_autopost_tick_and_triggers.sql` line 43; `supabase/migrations/20260429150000_autopost_fire_now_rpc.sql` line 67. Effort: 1 h. |
| DB-level re-anchor on `active=true` flip | ❌ | Latent: client paths re-anchor; direct SQL or a future admin tool would not. Effort: 0.5 h trigger on `BEFORE UPDATE`. |

---

## 2. Topic Generation

| Item | Status | Notes |
|------|--------|-------|
| Initial generation (intake form) | ✅ | `handleGenerateTopics` + Gemini `googleSearch`, 1.5s polling, 120s timeout. |
| Regenerate (more topics) | ✅ | `GenerateTopicsDialog` passes `existingTopics` for dedup. |
| Format consistency | ✅ | Worker injects FORMAT CONSISTENCY block when `existingTopics` are present. |
| Exclusion list | ✅ | Capped at 60 most-recent. |
| Source attachments | ✅ | `processAttachments` runs before enqueue. |
| `excludedCount` persistence across dialog opens | ⚠️ | Currently localStorage-only / ephemeral. File: `_GenerateTopicsDialog.tsx` line 79. Effort: 2 h. |
| `generate_topics` job row cleanup | ⚠️ | Rows accumulate forever — no TTL. Effort: 2 h scheduled cleanup. |

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
| Outer absolute timeout on `autopost_render` job | ❌ | If `waitForJob` polls forever (e.g., job stuck in `processing` past all phase timeouts), the worker holds a slot indefinitely. File: `worker/src/index.ts` `processJob`. Effort: 3 h `Promise.race(timeout)`. |
| Per-scene fallback for Kling rejection | ❌ | One bad scene fails the whole render. Options: retry with softened prompt, hold-frame fallback, skip scene. Effort: 6–8 h. |

---

## 4. Email Delivery

| Item | Status | Notes |
|------|--------|-------|
| Resend integration | ✅ | API key + verified `motionmax.io` from-address. |
| Recipient validation | ✅ | Regex on intake + edit dialog; server-side check for empty recipients. |
| Branded URLs | ✅ | Watch CTA → `motionmax.io/lab/autopost/runs/<id>`. |
| Thumbnail in email | ✅ | `handleAutopostRun` awaits thumbnail before returning so `thumbnail_url` is set before trigger fires. |
| `RESEND_FROM_EMAIL` startup validation | ⚠️ | If unset, emails go from sandbox `onboarding@resend.dev` — silently delivers only to verified accounts. Effort: 1 h startup check. |
| Per-recipient retry on Resend failure | ⚠️ | Failed recipients are logged but never retried. Effort: 3 h. |
| Email failure surfaced in Run Detail | ❌ | `recipient` key in details, RunDetail filters on `autopost_run_id`. Mismatch → log panel empty. File: `handleEmailDelivery.ts` lines 281-290. Effort: 2 h. |

---

## 5. Library Mode

| Item | Status | Notes |
|------|--------|-------|
| Run history rendering + filters | ✅ | Status / schedule / platform / date filters. Day-bucket grouping. Realtime updates. |
| Deletion + RLS + cascade | ✅ | `admins delete runs of own schedules` policy + `ON DELETE CASCADE` on publish_jobs. |
| Run detail (watch / download / open in editor) | ✅ | `finalUrl` + `projectId` resolved from render-job result. |
| Thumbnail freshness | ✅ | Generated once, public bucket URL. |
| Stale-run cleanup for `queued` (not just `generating`) | ⚠️ | Watchdog only sweeps `generating`. A `queued` run with no render job ever picked up sits forever. Effort: 1 h. |
| Pagination | ⚠️ | `limit(page * PAGE_SIZE)` re-fetches all earlier pages on every "Load more". Effort: 2 h cursor / range pagination. |

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
| `UpdateScheduleDialog` credit estimate | ⚠️ | Reads stale `duration_seconds` (now nullable). File: `_UpdateScheduleDialog.tsx` line 77. Effort: 1 h. |
| `estimateCredits()` accuracy | ⚠️ | Two-bucket heuristic underestimates cinematic. File: `_AutomationCard.tsx` lines 91-95. Effort: 1 h. |
| RunDetail log panel populated | ❌ | Most logs in `handleAutopostRun` lack `autopost_run_id` in details, so the filter returns empty. Effort: 2 h. |

---

## 7. DB / RLS / Security

| Item | Status | Notes |
|------|--------|-------|
| Admin gate (`is_admin(auth.uid())` everywhere) | ✅ | All four autopost tables. |
| Ownership policies | ✅ | RUN/JOB rows joined to `autopost_schedules.user_id`. |
| `SECURITY DEFINER` with `search_path` | ✅ | `autopost_tick`, `autopost_fire_now`. |
| Service-role not exposed in browser | ✅ | All writes go through admin-gated policies or RPCs. |
| FK cascade chain | ✅ | schedules→runs→publish_jobs all cascade. |
| `app_settings` write policy for authenticated admin | ❌ | Missing UPDATE policy — UI kill-switch toggle silently fails. Effort: 0.5 h migration. |
| OAuth token encryption (Supabase Vault) | ⚠️ | Plaintext TEXT. Not a blocker for email/library mode; required when social ships. Effort: 4 h. |

---

## 8. Observability

| Item | Status | Notes |
|------|--------|-------|
| `system_logs` per-phase coverage | ✅ | Render start/complete, thumbnail, email start/per-recipient/complete, dispatcher events. |
| `error_summary` user-friendly | ✅ | Em-dash unwrap surfaces leaf cause. |
| Queue-depth alerts to operator channel | ⚠️ | Logged to `system_logs`; nothing routes to Slack/PagerDuty. Effort: 4 h. |
| Daily summary email | ⚠️ | `dailySummary.ts` writes logs only — no email transport. Effort: 3 h. |
| RunDetail log panel populated | ❌ | (See §6.) |
| Metrics race-free updates | ⚠️ | Read-modify-write in `recordPublishOutcome`. Effort: 3 h SECURITY DEFINER RPC. |

---

## 9. Cost & Quotas

| Item | Status | Notes |
|------|--------|-------|
| Credit deduction at run kickoff | ❌ | Neither `autopost_tick` nor `autopost_fire_now` calls `deduct_credits_securely`. Every successful autopost is free. Effort: 4 h. |
| Refund logic correctness for `autopost_render` | ❌ | `refundCreditsOnFailure` falls back to `getCreditCost("doc2video","brief")` = phantom 280-credit refund. Effort: 2 h. |
| Pre-fire balance check | ⚠️ | No "insufficient credits" gate before the API spend. Effort: 2 h. |

---

## 10. Edge Cases & Resilience

| Item | Status | Notes |
|------|--------|-------|
| Deleted schedule mid-fire | ✅ | Cascade deletes the run row gracefully; trigger handles missing rows. |
| FK cascade on user delete | ✅ | Verified: schedules → runs → publish_jobs → social_accounts. |
| Empty topic pool guard | ❌ | (Same as §1.) |
| Pre-`config_snapshot` schedule fallback | ⚠️ | `config_snapshot` may be null on rows older than the column; defaults to smartflow / null voice. Effort: 1 h backfill migration. |
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
