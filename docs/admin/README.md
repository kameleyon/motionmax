# MotionMax Admin

Operator documentation for the `/admin` panel, the worker control surface, and the runbooks that describe how to act on what you see there.

## What is here

This directory contains everything an on-call operator or staff engineer needs to reason about the production system from the admin console:

- `README.md` (this file) — the entry point. 15-tab map, owners, and where to look first when something breaks.
- `runbooks/` — step-by-step procedures for the recurring actions the admin tab can trigger (master kill, incident response, newsletter sends, kill-switch deploys, revenue reconciliation, announcement publishing).

Per-RPC and per-table reference documentation lives in the migrations themselves (`supabase/migrations/*.sql`) as `COMMENT ON FUNCTION` / `COMMENT ON COLUMN` directives so it's the authoritative source and never drifts from the schema.

## The 15-tab structure

The admin shell at `/admin` is one route with a tabbed UI. State lives in the URL (`?tab=<key>`), so any tab is deep-linkable. Each tab is lazy-loaded as its own bundle chunk and wrapped in `AdminTabBoundary` so a render error in one tab can't take down the rest.

| # | Key | Tab name | Primary purpose | Owner |
|---|---|---|---|---|
| 1 | `overview` | Overview | KPI tiles + live activity feed across the whole system | Founder |
| 2 | `analytics` | Analytics | Funnel, cohort retention, acquisition, top countries | Growth |
| 3 | `activity` | Activity | Per-user / per-project audit trail of admin + system actions | Founder |
| 4 | `users` | Users | User search + detail drawer (sub, plan, generations, messages) | Support |
| 5 | `gens` | Generations | All `video_generation_jobs` with filters (failed, in-flight, by user) | Worker oncall |
| 6 | `perf` | Performance | Worker heartbeats, latency percentiles, queue depth | Worker oncall |
| 7 | `errors` | Errors | Grouped exceptions with resolve/snooze actions; drives the badge on the tab strip | Worker oncall |
| 8 | `console` | Console | Live tail of `system_logs` with grep + level filter | Worker oncall |
| 9 | `messages` | Messages | Admin inbox of user-initiated threads (support requests) | Support |
| 10 | `support` | Support | Support tickets queue with status + SLA tracking | Support |
| 11 | `notifs` | Notifications | Outbound notification dispatcher + queue health | Growth |
| 12 | `news` | Newsletter | Compose, schedule, and send newsletter campaigns | Growth |
| 13 | `announce` | Announcements | Publish in-app banners scoped by plan / severity / audience | Founder |
| 14 | `kill` | Kill switches | Subsystem pause flags (`pause_image`, `pause_video`, `pause_voice`, `pause_autopost`, `pause_newsletter`, `pause_payments`, `pause_signups`, `maintenance_mode`) and the `master_kill_switch` | Founder + super-admin only |
| 15 | `api` / `apikeys` | API & Keys | Internal API key issuance + provider-key health snapshot | Founder |

## Where to look first when something breaks

| Symptom | Start here |
|---|---|
| Specific user reports a problem | `users` → search → click → drawer shows their generations + messages |
| "All my exports are failing" | `gens` filter `status=failed` → group by error_message → check `errors` tab for stack trace |
| Worker crashing / OOMing | `perf` heartbeats panel → `console` tab grepped for `level:error` |
| Suspected upstream provider outage | `errors` tab grouping → expand top group → if multiple users hit the same provider error, engage the matching `pause_*` switch in `kill` |
| Need to stop everything | `kill` tab → engage `master_kill_switch`. See `runbooks/master-kill.md` |
| Newsletter going out wrong | `runbooks/newsletter-send.md` (mid-flight cancel procedure) |
| New user-facing announcement | `runbooks/announcement-publish.md` (channel + audience templates) |

## Architecture notes

- **Auth gate**: `src/components/AdminRoute.tsx` runs before any admin JS loads. Non-admin users see "Access Denied" with a link back to `/app`. The check is `useAdminAuth()` → `is_admin(auth.uid())` Postgres function.
- **Realtime**: 13 admin/operational tables are on the `supabase_realtime` publication (admin_logs, admin_messages, announcements, app_settings, autopost_*, dead_letter_jobs, feature_flags, system_logs, user_notifications, video_generation_jobs). Each tab subscribes to the table(s) it needs via `useAdminRealtimeChannel()` (`src/components/admin/_shared/useAdminRealtimeChannel.ts`) which provides reconnect-on-error and a "Connection lost — retrying" toast.
- **Cron + materialized views**: `cron.job` schedules 6 jobs — `refresh-admin-views` (every 15min), `drain-deletion-tasks` (every 15min), `process-deletion-requests` (daily 02:00), three `purge-*` jobs (daily 03:00–03:30). Verify health via `SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;`.
- **Audit trail**: every admin write action inserts a row into `public.admin_logs` with `(admin_id, action, target_type, target_id, details)`. Query for "what did admin X do today" or "who flipped feature_flag Y" via this table.
- **Rate limiting**: admin write RPCs adopt the `public.admin_rate_limit_check(p_action, p_max=60)` helper — 60 calls/minute per admin per action, raises `42501` on overrun.
- **Sentry**: every tab is wrapped in `AdminTabBoundary` which captures uncaught exceptions and tags them with `tab=<key>` for fast triage. A breadcrumb is dropped on every tab change so error reports include the navigation trail.

## Escalation paths

| Severity | Who | Channel |
|---|---|---|
| User-facing data loss or auth lockout | Founder | Pager |
| Worker stuck / queue backlog > 30 jobs / 30 min | Worker oncall | Pager + post in `#alerts` |
| Suspicious admin action (audit log shows unexpected `master_kill` engage) | Founder + security on-call | Pager |
| Newsletter or announcement misfire | Growth | `#alerts` post + reach out direct |
| Stripe / billing reconciliation drift > $50 | Founder | See `runbooks/revenue-reconciliation.md` |

## Operational runbooks

The detail of how to act on what you see in admin lives in `runbooks/`. Each runbook is structured: pre-flight checklist, action, post-action verification, rollback. Read the relevant one BEFORE engaging an action — most have post-action steps that are easy to forget under pressure.

- [master-kill.md](runbooks/master-kill.md) — when/how to engage `master_kill_switch`, what users see, comms templates, audit query.
- [incident-response.md](runbooks/incident-response.md) — Errors-tab triage flow, kill-switch decision matrix, resolve + comms.
- [newsletter-send.md](runbooks/newsletter-send.md) — pre-flight checklist, monitoring, mid-flight cancel, post-send signals.
- [kill-switch-deploy.md](runbooks/kill-switch-deploy.md) — adding a new feature flag, worker + edge-fn integration template.
- [revenue-reconciliation.md](runbooks/revenue-reconciliation.md) — daily check, deep reconcile flow, common Stripe-vs-DB disagreements, monthly close.
- [announcement-publish.md](runbooks/announcement-publish.md) — channel selection, audience templates, four canned announcement templates (maintenance / launch / incident / billing), monitoring, audit trail.

## How to add a new tab

1. Create `src/components/admin/tabs/TabXxx.tsx` exporting a named component.
2. Lazy-import it in `src/pages/Admin.tsx` (follow the existing `lazy(...)` pattern).
3. Add the tab key to `_shared/adminTabs.ts` (`TAB_KEYS` + `TAB_DEFINITIONS`) — TypeScript will refuse to compile until every switch in `renderTabContent` covers the new key.
4. Add the icon name to `_shared/AdminIcons.tsx` if it's a new icon.
5. Add a row to the table in this README's "15-tab structure" section.
6. If the tab subscribes to realtime, use `useAdminRealtimeChannel()` — don't call `supabase.channel()` directly.
7. If the tab calls write RPCs, route them through `_shared/adminRpc()` so latency + outcome land in `system_logs`.

## How to add a new admin write RPC

1. Write the migration. The function MUST `SECURITY DEFINER` and `SET search_path = public, pg_temp`.
2. As the FIRST statement after the BEGIN block, gate on identity:
   ```sql
   IF auth.uid() IS NULL OR NOT public.is_admin(auth.uid()) THEN
     RAISE EXCEPTION '<rpc_name>: forbidden' USING ERRCODE = '42501';
   END IF;
   ```
   For destructive or org-wide actions (master kill, hard delete, force signout, drop critical announcement), gate on `public.is_super_admin(auth.uid())` instead.
3. Apply the rate limit (recommended for any mutating RPC):
   ```sql
   PERFORM public.admin_rate_limit_check('<action_key>', 60);
   ```
4. Insert an audit row:
   ```sql
   INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
   VALUES (auth.uid(), '<action>', '<target_type>', <target_id>, jsonb_build_object(...));
   ```
5. `REVOKE ALL ON FUNCTION ... FROM anon` and `GRANT EXECUTE ... TO authenticated`.
6. Document the RPC's purpose, gates, and return shape via `COMMENT ON FUNCTION`.
