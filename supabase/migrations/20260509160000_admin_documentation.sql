-- ============================================================
-- Phase 19.7 — admin_* RPC + admin-table column documentation
-- ============================================================
-- 66 admin_* RPCs + ~130 columns across 13 admin tables had
-- pg_description = NULL prior to this migration. Closes the two
-- "documentation gap" findings from the 2026-05-09 audit.
--
-- Writing style: each comment describes WHAT the function/column
-- represents, gating constraints, and any non-obvious semantic.
-- Comments should not duplicate the function signature (already
-- visible via pg_get_function_identity_arguments) — they describe
-- intent and contract.

BEGIN;

-- ── KPI RPCs (return one-row aggregate metrics for dashboards) ──────
COMMENT ON FUNCTION public.admin_analytics_kpis() IS
  'Top-line KPIs for the Analytics tab — DAU/MAU, conversion rate, ARR snapshot. Admin-only. Returns a single row of denormalised counters computed from materialized views, refreshed by the admin-views cron every 15 min.';

COMMENT ON FUNCTION public.admin_announcements_kpis() IS
  'KPIs for the Announcements tab — count of active announcements, dismissals last 24h, click-through rate. Admin-only. Backs the badge on the tab strip + the headline tiles.';

COMMENT ON FUNCTION public.admin_api_cost_kpis() IS
  'KPIs for the API & Costs tab — total spend MTD, top 3 providers by cost, cost-per-generation trend. Admin-only.';

COMMENT ON FUNCTION public.admin_api_keys_kpis() IS
  'KPIs for the API Keys tab — active key count, calls in last 7d, revoked count. Admin-only.';

COMMENT ON FUNCTION public.admin_errors_kpis() IS
  'KPIs for the Errors tab — open error signature count, errors in last 24h, top failing event_type. Drives the badge on the Errors tab. Admin-only.';

COMMENT ON FUNCTION public.admin_generations_kpis() IS
  'KPIs for the Generations tab — total generations, in-flight, failed last 24h, p50/p95 wall-clock. Admin-only.';

COMMENT ON FUNCTION public.admin_kill_switches_kpis() IS
  'KPIs for the Kill Switches tab — count of armed pause_* flags, master kill state, last-toggle admin. Admin-only.';

COMMENT ON FUNCTION public.admin_messages_kpis() IS
  'KPIs for the Messages tab — unread admin-side thread count, average response time, threads opened in last 7d. Admin-only.';

COMMENT ON FUNCTION public.admin_newsletter_kpis() IS
  'KPIs for the Newsletter tab — campaigns sent MTD, opt-out rate, average open rate. Admin-only.';

COMMENT ON FUNCTION public.admin_notifications_kpis() IS
  'KPIs for the Notifications tab — unread alert count across all users, dispatch backlog, send failures last 24h. Admin-only.';

COMMENT ON FUNCTION public.admin_perf_kpis() IS
  'KPIs for the Performance tab — worker heartbeat freshness, queue depth, p50/p95 job latency. Admin-only.';

COMMENT ON FUNCTION public.admin_users_kpis() IS
  'KPIs for the Users tab — active subscribers, free-plan users, churn rate, signups last 7d. Admin-only.';

-- ── Paginated list RPCs ────────────────────────────────────────────
COMMENT ON FUNCTION public.admin_activity_feed(timestamp with time zone, uuid, text[], integer) IS
  'Time-ordered system activity feed for the Activity tab + user drawer. Filters: since (default 24h), user_id (single-user view), event_types (event_type prefix match). Admin-only. Limit defaults to 100, max 500.';

COMMENT ON FUNCTION public.admin_error_groups(timestamp with time zone, integer) IS
  'Groups of similar errors by fingerprint, sorted by recent occurrence count. Backs the Errors tab grouped list. Admin-only. Limit defaults to 50.';

COMMENT ON FUNCTION public.admin_feature_flags_list() IS
  'All feature_flags rows with rollout_pct, audience, last-modifier metadata. Backs the Kill Switches tab grid. Admin-only. Not paginated — feature_flags table is small (<100 rows).';

COMMENT ON FUNCTION public.admin_generations_list(text, text, text, timestamp with time zone, integer, integer) IS
  'Paginated list of video_generation_jobs filtered by search (project/user), status, type (project_type), and since. Used by the Generations tab. Admin-only. Default page 50 / max 200, p_page is 1-indexed.';

COMMENT ON FUNCTION public.admin_list_support_tickets(text, integer) IS
  'Paginated support_tickets list filtered by status. Backs the Support tab queue. Admin-only.';

COMMENT ON FUNCTION public.admin_top_expensive_calls(timestamp with time zone, integer) IS
  'Top N most-expensive provider API calls in the time window, sorted by cost desc. Used by API & Costs tab to surface cost outliers. Admin-only.';

COMMENT ON FUNCTION public.admin_top_users_by_spend(timestamp with time zone, integer) IS
  'Top N users by total provider spend in the window. Joins generations → api_call_logs → user. Admin-only.';

COMMENT ON FUNCTION public.admin_users_list(text, text, text, text, integer, integer) IS
  'Paginated users list with admin-relevant joins (subscription, last_active_at, generation count, flagged state). Filters: search (email/display_name), plan, status, flag_state. Admin-only. Default page 50 / max 200.';

COMMENT ON FUNCTION public.admin_workers_list() IS
  'Live worker_heartbeats list with last-seen timestamp, slot utilization, RSS, and current job count. Backs the Performance tab worker grid. Admin-only.';

-- ── Detail RPCs (single record with joins) ─────────────────────────
COMMENT ON FUNCTION public.admin_campaign_detail(uuid) IS
  'Full campaign detail for the Newsletter tab drawer — campaign row + recipient counts + send progress + per-send-job status. Admin-only.';

COMMENT ON FUNCTION public.admin_generation_detail(uuid) IS
  'Full generation detail for the Generations tab drawer — gen row + linked jobs + scene-level progress + cost tally. Admin-only.';

COMMENT ON FUNCTION public.admin_user_full_detail(uuid) IS
  'Aggregate single-round-trip user view for the Users tab drawer: profile + auth + subscription + credits + last 30d generations + open threads + recent admin_logs. Admin-only.';

-- ── Analytics functions ────────────────────────────────────────────
COMMENT ON FUNCTION public.admin_analytics_funnel(timestamp with time zone) IS
  'Conversion funnel: visited → signed up → generated → subscribed, in 6 colour-graded rows for the Analytics tab. Note: visited row uses signup-base estimate until true visit-tracking ships (Phase 18).';

COMMENT ON FUNCTION public.admin_analytics_plan_mix() IS
  'Plan-distribution donut data for the Analytics tab: free / starter / pro / studio counts and percentage shares. Admin-only.';

COMMENT ON FUNCTION public.admin_analytics_project_type_mix() IS
  'Project-type donut: smartflow / cinematic / doc2video / autopost share. Admin-only.';

COMMENT ON FUNCTION public.admin_analytics_timeseries(text, timestamp with time zone) IS
  'Time-series for one of: signups, generations, revenue, churn. Daily buckets by default. Admin-only.';

-- ── API / cost analytics ───────────────────────────────────────────
COMMENT ON FUNCTION public.admin_api_calls_weekly() IS
  'API call counts grouped by provider for the last 7 days, used by the API & Costs tab weekly chart. Admin-only.';

COMMENT ON FUNCTION public.admin_api_cost_breakdown(timestamp with time zone, text) IS
  'Cost breakdown by group_by dimension (provider | model | event_type) for the API & Costs tab table. Admin-only.';

-- ── Performance functions ──────────────────────────────────────────
COMMENT ON FUNCTION public.admin_perf_percentiles(timestamp with time zone, text) IS
  'p50/p95/p99 latency by dimension (job_type | worker_id | hour-of-day) for the Performance tab. Admin-only.';

COMMENT ON FUNCTION public.admin_perf_phase_timing() IS
  'Average wall-clock spent in each pipeline phase (script / image / audio / video / finalize / export) for the Performance tab phase-breakdown chart. Admin-only.';

COMMENT ON FUNCTION public.admin_perf_throughput_14d() IS
  'Daily completed-job count for the last 14 days, used by the Performance tab throughput sparkline. Admin-only.';

-- ── Overview tab ────────────────────────────────────────────────────
COMMENT ON FUNCTION public.admin_overview_cost_split() IS
  'Cost split by provider for the Overview tab donut — Hypereal / OpenRouter / ElevenLabs / Replicate / Stripe-fees / etc. Admin-only.';

COMMENT ON FUNCTION public.admin_overview_snapshot() IS
  'Single-call aggregate for the Overview tab: 6 KPI tiles + sparklines + live-activity-tail header. Admin-only.';

-- ── Mutations: announcements ───────────────────────────────────────
COMMENT ON FUNCTION public.admin_create_announcement(text, text, text, text, text, jsonb, timestamp with time zone, timestamp with time zone) IS
  'Create a new announcement banner. Admin-only. Audit-logged. severity in (info|warning|critical); audience is a JSONB plan/segment filter; starts_at/ends_at gate visibility window.';

COMMENT ON FUNCTION public.admin_archive_announcement(uuid) IS
  'Archive an announcement so it stops rendering immediately (sets active=false). Admin-only. Audit-logged. Idempotent on already-archived rows.';

-- ── Mutations: newsletter campaigns ────────────────────────────────
COMMENT ON FUNCTION public.admin_create_campaign(text, text, text, text) IS
  'Create a draft newsletter campaign. Admin-only. Audit-logged. audience is a string segment key (all|paid|free|trial). Sends do NOT happen on create; use admin_schedule_campaign or admin_send_test_to_self.';

COMMENT ON FUNCTION public.admin_cancel_campaign(uuid) IS
  'Cancel a campaign. Refuses if status=sent or status=sending in flight. Admin-only. Audit-logged. Idempotent.';

COMMENT ON FUNCTION public.admin_clone_campaign(uuid) IS
  'Duplicate a campaign''s subject + body + audience into a new draft. Admin-only. Audit-logged. Caller usually edits the clone before scheduling.';

COMMENT ON FUNCTION public.admin_schedule_campaign(uuid, timestamp with time zone) IS
  'Mark a campaign as scheduled at a future time; the newsletter sender cron picks it up at that time. Admin-only. Audit-logged.';

COMMENT ON FUNCTION public.admin_send_test_to_self(uuid) IS
  'Send a test render of the campaign to the calling admin''s own email only. Useful pre-flight before mass send. Admin-only. Audit-logged.';

-- ── Mutations: users ───────────────────────────────────────────────
COMMENT ON FUNCTION public.admin_set_user_status(uuid, text, text) IS
  'Change a user account''s status (active|paused|suspended|deleted). Admin-only. Audit-logged with reason. paused/suspended users can still authenticate but cannot generate; deleted triggers async hard-delete.';

COMMENT ON FUNCTION public.admin_bulk_grant_credits(uuid[], integer, text) IS
  'Apply admin_grant_credits to a batch of users in one transaction. Super-admin recommended for large batches. Audit-logged per user. Range guard +/-1,000,000 credits applies per user (NOT per batch).';

COMMENT ON FUNCTION public.admin_bulk_suspend(uuid[], text) IS
  'Suspend multiple user accounts in one transaction. Reason is recorded per user. Admin-only. Audit-logged.';

COMMENT ON FUNCTION public.admin_get_user_emails(uuid[]) IS
  'Resolve a batch of user_ids to their auth.users.email addresses. Admin-only. Used by Users tab list-rendering, Communicate, and audit drawers.';

COMMENT ON FUNCTION public.admin_get_user_id_by_email(text) IS
  'Reverse lookup: email to user_id. Returns NULL if not found. Admin-only. Used by Users tab search and the Communicate compose flow.';

-- ── Mutations: threads / messages ──────────────────────────────────
COMMENT ON FUNCTION public.admin_close_thread(uuid, text) IS
  'Mark an admin_message_thread as closed (resolved). Notes are stored in the thread''s details JSONB. Admin-only. Audit-logged. Idempotent.';

COMMENT ON FUNCTION public.admin_open_thread(uuid, text, text) IS
  'Open a new admin to user thread. Used by the Users tab drawer Communicate panel. Admin-only. Audit-logged. Triggers the notify-user-of-message edge function for email + push.';

COMMENT ON FUNCTION public.admin_post_reply(uuid, text, jsonb) IS
  'Append an admin reply to an existing thread. attachments JSONB carries optional file references. Admin-only. Audit-logged. Triggers email notification to the user.';

COMMENT ON FUNCTION public.admin_flag_thread(uuid, text[]) IS
  'Apply moderation tags (spam|abuse|priority|escalation) to a thread for triage. Admin-only. Audit-logged. Tags are stored on admin_message_threads.tags.';

COMMENT ON FUNCTION public.admin_mark_message_read(uuid) IS
  'Mark a single admin_messages row as read by the calling admin. Admin-only. Drives the unread badge on the Messages tab.';

-- ── Mutations: jobs / queue / errors ───────────────────────────────
COMMENT ON FUNCTION public.admin_force_complete_job(uuid, jsonb, text) IS
  'Force a stuck video_generation_jobs row to status=completed with a synthetic result jsonb. Admin-only. Audit-logged. Use sparingly — bypasses the worker''s pipeline guarantees.';

COMMENT ON FUNCTION public.admin_requeue_dead_letter(uuid) IS
  'Re-insert a dead_letter_jobs row back into video_generation_jobs as pending. Admin-only. Audit-logged. Used to retry jobs that failed after the worker''s normal retry budget exhausted.';

COMMENT ON FUNCTION public.admin_request_worker_restart(text) IS
  'Mark a specific worker_id for shutdown — the worker reads its own restart flag from worker_heartbeats and gracefully drains. Admin-only. Audit-logged.';

COMMENT ON FUNCTION public.admin_restore_missing_refunds(uuid, integer) IS
  'Backfill missing credit refunds for a user''s failed jobs in the last p_days_back days. Admin-only. Audit-logged. Used to recover from worker bugs that failed jobs without refunding.';

COMMENT ON FUNCTION public.admin_resolve_error_group(text, text) IS
  'Mark all errors with this fingerprint as resolved (snoozed) so the Errors tab list filters them out. Notes are appended to the audit row. Admin-only. Audit-logged.';

-- ── Mutations: internal API keys ───────────────────────────────────
COMMENT ON FUNCTION public.admin_create_internal_key(text, text[], text) IS
  'Issue a new internal API key with the given name and scope array. Returns the plaintext token EXACTLY ONCE — caller must store it; subsequent reads return only the masked prefix. Admin-only. Audit-logged.';

COMMENT ON FUNCTION public.admin_revoke_internal_key(uuid, text) IS
  'Revoke an internal API key (sets status=revoked). Subsequent calls using the token return 401. Admin-only. Audit-logged. Idempotent.';

COMMENT ON FUNCTION public.admin_rotate_internal_key(uuid) IS
  'Mint a new key with the same name + scope as the input, mark the original as revoked, and return the new plaintext token (one-time read). Admin-only. Audit-logged.';

-- ── Mutations: notifications ───────────────────────────────────────
COMMENT ON FUNCTION public.admin_send_notification(uuid[], text, text, text, text) IS
  'Deliver an in-app + email notification to a specific user_id list. Admin-only. Audit-logged. severity in (info|warning|critical); cta_url is optional.';

COMMENT ON FUNCTION public.admin_send_notification_to_segment(text, text, text, text, text) IS
  'Deliver a notification to every user matching a segment string (all|paid|free|trial). Admin-only. Audit-logged. Use admin_send_notification for targeted delivery.';

-- ── Mutations: support tickets ─────────────────────────────────────
COMMENT ON FUNCTION public.admin_update_ticket_status(uuid, text, uuid, text) IS
  'Update a support_tickets row''s status, assignee, and admin notes. Admin-only. Audit-logged. status in (open|in_progress|resolved|closed).';

-- ============================================================
-- Column-level documentation
-- ============================================================
-- 13 admin tables, columns verified against information_schema on
-- 2026-05-09. Primary keys + standard timestamps get a short note
-- since their meaning is universally understood.

-- ── admin_logs ─────────────────────────────────────────────────────
COMMENT ON COLUMN public.admin_logs.id IS 'Primary key (uuid).';
COMMENT ON COLUMN public.admin_logs.admin_id IS 'auth.users.id of the admin who performed the action. NEVER null for normal flows; only nullable for system-initiated migrations.';
COMMENT ON COLUMN public.admin_logs.action IS 'Action key (e.g. master_kill_switch_set, feature_flag_set, user_status_changed). Stable identifier, not human-facing.';
COMMENT ON COLUMN public.admin_logs.target_type IS 'Type of entity the action targeted (e.g. user, app_setting, feature_flag). Used with target_id for entity grouping.';
COMMENT ON COLUMN public.admin_logs.target_id IS 'UUID of the target entity. NULL when the action is global (e.g. flipping a feature flag has no entity target).';
COMMENT ON COLUMN public.admin_logs.details IS 'JSONB with action-specific metadata. By Phase 18.5 convention includes a request_id UUID for multi-step flows so side-effect logs share an ID.';
COMMENT ON COLUMN public.admin_logs.ip_address IS 'IP address of the admin client when the action fired. Optional — system-initiated actions leave it NULL.';
COMMENT ON COLUMN public.admin_logs.user_agent IS 'User-agent string from the admin client. Optional — same nullable semantics as ip_address.';
COMMENT ON COLUMN public.admin_logs.created_at IS 'Server timestamp at insert. Index supports time-windowed queries for the Activity tab.';
COMMENT ON COLUMN public.admin_logs.updated_at IS 'Last modification timestamp. admin_logs rows are append-only by convention so this typically equals created_at.';
COMMENT ON COLUMN public.admin_logs.request_id IS 'Optional UUID linking this log to other rows from the same multi-step flow. The request_id is also embedded in details->>''request_id'' for backwards compatibility.';

-- ── admin_message_threads ──────────────────────────────────────────
COMMENT ON COLUMN public.admin_message_threads.id IS 'Primary key (uuid).';
COMMENT ON COLUMN public.admin_message_threads.user_id IS 'auth.users.id this thread belongs to. RLS uses this for the user-self-view policy.';
COMMENT ON COLUMN public.admin_message_threads.subject IS 'Initial subject line set when the thread was opened. Not editable after creation.';
COMMENT ON COLUMN public.admin_message_threads.status IS 'open | closed. Closed threads stop generating notifications when replies arrive.';
COMMENT ON COLUMN public.admin_message_threads.last_message_at IS 'Timestamp of the most recent message in the thread. Used for inbox sort order.';
COMMENT ON COLUMN public.admin_message_threads.created_at IS 'Thread creation time.';
COMMENT ON COLUMN public.admin_message_threads.closed_at IS 'Timestamp the thread was marked closed. NULL while open.';
COMMENT ON COLUMN public.admin_message_threads.closed_by IS 'auth.users.id (admin) who closed the thread. NULL if open or auto-closed.';
COMMENT ON COLUMN public.admin_message_threads.tags IS 'Moderation/triage tag array — spam | abuse | priority | escalation. Set by admin_flag_thread.';
COMMENT ON COLUMN public.admin_message_threads.csat_score IS 'Customer satisfaction score (1-5) submitted by the user after thread close. NULL if no rating.';
COMMENT ON COLUMN public.admin_message_threads.csat_at IS 'Timestamp the CSAT score was submitted.';
COMMENT ON COLUMN public.admin_message_threads.csat_comment IS 'Optional free-text feedback the user attached to the CSAT score.';
COMMENT ON COLUMN public.admin_message_threads.csat_token IS 'One-time token emailed to the user for submitting CSAT without re-authenticating. Single-use.';

-- ── admin_messages ─────────────────────────────────────────────────
COMMENT ON COLUMN public.admin_messages.id IS 'Primary key (uuid).';
COMMENT ON COLUMN public.admin_messages.thread_id IS 'FK to admin_message_threads. RLS joins through this for user-self-view enforcement.';
COMMENT ON COLUMN public.admin_messages.sender_id IS 'auth.users.id of the message sender. Compared to thread.user_id (along with sender_role) to determine direction.';
COMMENT ON COLUMN public.admin_messages.sender_role IS 'Direction marker: admin | user. Lets the UI render the right bubble side without joining auth.users.';
COMMENT ON COLUMN public.admin_messages.body IS 'Message body in markdown. Rendered with the Tiptap-compatible RichEditor on the admin side.';
COMMENT ON COLUMN public.admin_messages.attachments IS 'JSONB array of attachment descriptors {url, mime, size}. Files live in the admin-attachments storage bucket.';
COMMENT ON COLUMN public.admin_messages.read_at IS 'Per-row read timestamp. Updated by admin_mark_message_read. Drives the unread badge.';
COMMENT ON COLUMN public.admin_messages.created_at IS 'Send timestamp.';

-- ── announcement_clicks ────────────────────────────────────────────
COMMENT ON COLUMN public.announcement_clicks.id IS 'Primary key (uuid).';
COMMENT ON COLUMN public.announcement_clicks.announcement_id IS 'FK to announcements.id. Each row = one CTA click.';
COMMENT ON COLUMN public.announcement_clicks.user_id IS 'Clicking user''s auth.users.id. NULL for anonymous (logged-out) clicks.';
COMMENT ON COLUMN public.announcement_clicks.ip IS 'Client IP at click time. Used for rate-limiting + de-duplicating clicks per user.';
COMMENT ON COLUMN public.announcement_clicks.user_agent IS 'Client user-agent string at click time.';
COMMENT ON COLUMN public.announcement_clicks.clicked_at IS 'Timestamp of the click.';

-- ── announcements ──────────────────────────────────────────────────
COMMENT ON COLUMN public.announcements.id IS 'Primary key (uuid).';
COMMENT ON COLUMN public.announcements.title IS 'Banner title rendered in-app.';
COMMENT ON COLUMN public.announcements.body_md IS 'Body in markdown. Rendered with sanitised markdown-to-HTML on the client.';
COMMENT ON COLUMN public.announcements.severity IS 'info | warning | critical. Drives banner colour + icon.';
COMMENT ON COLUMN public.announcements.cta_label IS 'Optional CTA button text. NULL renders no button.';
COMMENT ON COLUMN public.announcements.cta_url IS 'Optional CTA destination URL.';
COMMENT ON COLUMN public.announcements.audience IS 'JSONB targeting filter (e.g. {"plan": "studio", "all": false}). Empty/{"all": true} means everyone.';
COMMENT ON COLUMN public.announcements.starts_at IS 'Visibility start time. Banners do not render before this.';
COMMENT ON COLUMN public.announcements.ends_at IS 'Visibility end time. Banners stop rendering at/after this. NULL = no end (live until archived via active=false).';
COMMENT ON COLUMN public.announcements.active IS 'Master toggle. false = archived; admin_archive_announcement flips this. Independent of starts_at/ends_at.';
COMMENT ON COLUMN public.announcements.created_by IS 'auth.users.id of the creating admin.';
COMMENT ON COLUMN public.announcements.created_at IS 'Creation timestamp.';
COMMENT ON COLUMN public.announcements.updated_at IS 'Last modification timestamp.';

-- ── app_settings ───────────────────────────────────────────────────
COMMENT ON COLUMN public.app_settings.key IS 'Setting identifier. Well-known keys: master_kill_switch, newsletter_unsubscribe_secret. Free-form for forward extensibility.';
COMMENT ON COLUMN public.app_settings.value IS 'JSONB value. Schema is per-key (see admin_set_master_kill_switch for the master_kill_switch shape).';
COMMENT ON COLUMN public.app_settings.updated_at IS 'Last write timestamp. Used by the worker''s 10s cache TTL on master_kill_switch.';

-- ── feature_flags ──────────────────────────────────────────────────
COMMENT ON COLUMN public.feature_flags.flag_name IS 'Primary key. Convention: pause_* for kill switches (enabled=true means BLOCKED), image_provider_* for positive provider gates (enabled=true means ON). See migration 20260508240000 for the rename.';
COMMENT ON COLUMN public.feature_flags.enabled IS 'Boolean state. Semantic depends on flag_name prefix (see flag_name comment).';
COMMENT ON COLUMN public.feature_flags.description IS 'Human-readable description shown in the Kill Switches tab.';
COMMENT ON COLUMN public.feature_flags.rollout_pct IS '0-100 staged rollout percentage. Currently advisory — workers do not yet bucket users by this value (Phase 18.4 future work).';
COMMENT ON COLUMN public.feature_flags.audience IS 'JSONB audience filter. Like announcements.audience — empty means everyone.';
COMMENT ON COLUMN public.feature_flags.updated_by IS 'String identifier of the last writer. Often an admin uuid as text; sometimes a migration tag (e.g. rename-2026-05-08).';
COMMENT ON COLUMN public.feature_flags.updated_at IS 'Last write timestamp. Workers re-fetch via the 60s flag-cache TTL.';

-- ── support_tickets ────────────────────────────────────────────────
COMMENT ON COLUMN public.support_tickets.id IS 'Primary key (uuid).';
COMMENT ON COLUMN public.support_tickets.user_id IS 'Reporting user''s auth.users.id. NULL for anonymous reports submitted via the public support form.';
COMMENT ON COLUMN public.support_tickets.email IS 'Reporter email address. For authenticated reporters this duplicates auth.users.email; for anon reporters it is the form-supplied address.';
COMMENT ON COLUMN public.support_tickets.name IS 'Reporter display name. Optional; for anon reporters captured from the form.';
COMMENT ON COLUMN public.support_tickets.subject IS 'Short subject line.';
COMMENT ON COLUMN public.support_tickets.body IS 'Description body in markdown.';
COMMENT ON COLUMN public.support_tickets.topic IS 'Free-form topic tag (billing | bug | feature_request | other) chosen by the reporter from the form dropdown.';
COMMENT ON COLUMN public.support_tickets.status IS 'open | in_progress | resolved | closed. Updated by admin_update_ticket_status.';
COMMENT ON COLUMN public.support_tickets.assigned_to IS 'auth.users.id of the admin currently owning the ticket. NULL for unassigned.';
COMMENT ON COLUMN public.support_tickets.admin_notes IS 'Internal-only notes visible to admins, never to the reporter.';
COMMENT ON COLUMN public.support_tickets.created_at IS 'Submission time.';
COMMENT ON COLUMN public.support_tickets.updated_at IS 'Last modification time.';

-- ── user_notifications ─────────────────────────────────────────────
COMMENT ON COLUMN public.user_notifications.id IS 'Primary key (uuid).';
COMMENT ON COLUMN public.user_notifications.user_id IS 'Recipient auth.users.id.';
COMMENT ON COLUMN public.user_notifications.template_slug IS 'Template/kind slug (admin_message | generation_complete | billing | announcement | system). Drives icon + grouping.';
COMMENT ON COLUMN public.user_notifications.title IS 'Notification title rendered in-app and in the email subject.';
COMMENT ON COLUMN public.user_notifications.body IS 'Body content in markdown.';
COMMENT ON COLUMN public.user_notifications.cta_url IS 'Optional click-through URL for the notification.';
COMMENT ON COLUMN public.user_notifications.icon IS 'Optional icon hint (e.g. info | check | warn | bell). UI falls back to template_slug-based default if NULL.';
COMMENT ON COLUMN public.user_notifications.severity IS 'info | warning | critical. Drives bell-icon dot colour.';
COMMENT ON COLUMN public.user_notifications.delivered_at IS 'Server timestamp the realtime push + email were emitted. NULL until the dispatcher picks the row up.';
COMMENT ON COLUMN public.user_notifications.read_at IS 'Per-user read timestamp. NULL = unread, drives the bell badge.';
COMMENT ON COLUMN public.user_notifications.dismissed_at IS 'Set when the user explicitly dismisses the notification. Distinct from read_at.';
COMMENT ON COLUMN public.user_notifications.scheduled_for IS 'Future-dated send time. NULL = immediate. Notifications with scheduled_for > NOW() are not yet picked up by the dispatcher.';
COMMENT ON COLUMN public.user_notifications.sent_by_admin_id IS 'auth.users.id of the admin who triggered this notification (when applicable). NULL for system-generated notifications.';
COMMENT ON COLUMN public.user_notifications.created_at IS 'Row insert time. Distinct from delivered_at.';

-- ── dead_letter_jobs ───────────────────────────────────────────────
COMMENT ON COLUMN public.dead_letter_jobs.id IS 'Primary key (uuid).';
COMMENT ON COLUMN public.dead_letter_jobs.source_job_id IS 'Original video_generation_jobs.id this dead-letter row was minted from.';
COMMENT ON COLUMN public.dead_letter_jobs.task_type IS 'Original job''s task_type (cinematic_image, generate_video, etc.).';
COMMENT ON COLUMN public.dead_letter_jobs.payload IS 'Original job payload at time of failure. Used by admin_requeue_dead_letter to re-queue.';
COMMENT ON COLUMN public.dead_letter_jobs.error_message IS 'Last error_message from the original job''s final failure. Used as the human-readable failure summary in the UI.';
COMMENT ON COLUMN public.dead_letter_jobs.attempts IS 'Number of attempts the original job made before being moved here. Includes the worker''s internal retries.';
COMMENT ON COLUMN public.dead_letter_jobs.user_id IS 'Original job owner. Used for per-user filtering in the Errors tab.';
COMMENT ON COLUMN public.dead_letter_jobs.project_id IS 'Project the original job belonged to. Lets the Errors tab link back to the project drawer.';
COMMENT ON COLUMN public.dead_letter_jobs.worker_id IS 'worker_heartbeats.worker_id of the last worker that processed the original job before it failed.';
COMMENT ON COLUMN public.dead_letter_jobs.failed_at IS 'Timestamp of the original job''s final failure (distinct from created_at, which is when this dead-letter row was minted).';
COMMENT ON COLUMN public.dead_letter_jobs.created_at IS 'Time the dead-letter row was minted. Drives the purge-dead-letter-jobs cron retention.';

-- ── autopost_runs ──────────────────────────────────────────────────
COMMENT ON COLUMN public.autopost_runs.id IS 'Primary key (uuid).';
COMMENT ON COLUMN public.autopost_runs.schedule_id IS 'FK to autopost_schedules. The schedule that fired this run.';
COMMENT ON COLUMN public.autopost_runs.fired_at IS 'Time the schedule cron fired this run.';
COMMENT ON COLUMN public.autopost_runs.topic IS 'Topic title for this run. Pulled from the schedule''s topic_pool head at fire time.';
COMMENT ON COLUMN public.autopost_runs.prompt_resolved IS 'Resolved prompt template after substituting per-run placeholders. Stored for replay/debug.';
COMMENT ON COLUMN public.autopost_runs.video_job_id IS 'FK to video_generation_jobs.id of the orchestrator job that drove this run. NULL if the run never queued a job (early failure).';
COMMENT ON COLUMN public.autopost_runs.status IS 'pending | generating | rendering | publishing | completed | failed. Distinct from worker job status; tracks the run-level lifecycle.';
COMMENT ON COLUMN public.autopost_runs.error_summary IS 'Human-readable failure description. Set when status=failed.';
COMMENT ON COLUMN public.autopost_runs.thumbnail_url IS 'Public URL of the run''s thumbnail (first scene''s image). Used in the Autopost tab run list.';
COMMENT ON COLUMN public.autopost_runs.thumbnail_storage_path IS 'Internal storage path for the thumbnail (project-thumbnails bucket). Used for re-signing if the public URL expires.';
COMMENT ON COLUMN public.autopost_runs.progress_pct IS 'Coarse progress 0-100, derived from sub-job completion. Used for the Autopost tab progress bars.';

COMMIT;
