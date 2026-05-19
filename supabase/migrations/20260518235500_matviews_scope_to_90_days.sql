-- ============================================================
-- Scope admin_mv_* defining SELECTs to the last 90 days.
-- ============================================================
-- Background: the admin dashboard matviews aggregated all-time data
-- on every CONCURRENTLY refresh — each refresh re-scanned every row
-- in api_call_logs, generations, video_generation_jobs, etc., which
-- grew unboundedly with usage. At 8k jobs and 28k system_logs the
-- refresh was already taking 5-30s; at 80k it would be 50-300s and
-- the refresh would routinely time out (we saw 35s spikes earlier
-- today). 90 days is enough for every active dashboard chart and
-- still allows year-over-year comparisons via the funnel matview
-- (which intentionally stays all-time).
--
-- Filter is applied in the defining SELECT (NOT in the calling SQL)
-- so REFRESH MATERIALIZED VIEW CONCURRENTLY automatically scopes to
-- 90 days. The filter uses the same column the matview groups by, so
-- the result row count stays consistent.
--
-- Two matviews intentionally NOT filtered:
--   - admin_mv_funnel_weekly: funnel cohort analysis needs all-time
--     signups to compute conversion rates. Small table (auth.users
--     + projects + generations + subscriptions DISTINCT).
--   - admin_mv_project_type_mix: already has last_7d/last_30d FILTER
--     columns built in; the total counts column needs all-time.
--
-- Each matview is rebuilt independently (separate BEGIN/COMMIT) so a
-- failure on one does not block the rest. PostgreSQL has no CREATE
-- OR REPLACE MATERIALIZED VIEW, so the pattern is DROP + CREATE +
-- recreate-unique-index (required for CONCURRENTLY refresh).
-- ============================================================

-- ── 1. admin_mv_api_costs_daily ─────────────────────────────────
BEGIN;
DROP MATERIALIZED VIEW IF EXISTS public.admin_mv_api_costs_daily CASCADE;
CREATE MATERIALIZED VIEW public.admin_mv_api_costs_daily AS
  SELECT (date_trunc('day'::text, created_at))::date AS day,
    COALESCE(provider, 'unknown'::text) AS provider,
    COALESCE(model, 'unknown'::text)    AS model,
    COALESCE(status, 'unknown'::text)   AS status,
    (count(*))::integer                 AS calls,
    COALESCE(sum(cost), (0)::numeric)   AS spend,
    COALESCE(avg(total_duration_ms), (0)::numeric) AS avg_ms
  FROM api_call_logs
  WHERE created_at > (now() - interval '90 days')
  GROUP BY ((date_trunc('day'::text, created_at))::date),
           COALESCE(provider, 'unknown'::text),
           COALESCE(model, 'unknown'::text),
           COALESCE(status, 'unknown'::text)
  ORDER BY ((date_trunc('day'::text, created_at))::date) DESC,
           COALESCE(provider, 'unknown'::text),
           COALESCE(model, 'unknown'::text),
           COALESCE(status, 'unknown'::text);

CREATE UNIQUE INDEX admin_mv_api_costs_daily_day_provider_model_status_idx
  ON public.admin_mv_api_costs_daily (day, provider, model, status);
COMMIT;

-- ── 2. admin_mv_daily_active_users ──────────────────────────────
BEGIN;
DROP MATERIALIZED VIEW IF EXISTS public.admin_mv_daily_active_users CASCADE;
CREATE MATERIALIZED VIEW public.admin_mv_daily_active_users AS
  SELECT (date_trunc('day'::text, created_at))::date AS day,
    count(DISTINCT user_id) AS active_users
  FROM generations
  WHERE created_at > (now() - interval '90 days')
  GROUP BY ((date_trunc('day'::text, created_at))::date)
  ORDER BY ((date_trunc('day'::text, created_at))::date) DESC;

CREATE UNIQUE INDEX admin_mv_daily_active_users_day_idx
  ON public.admin_mv_daily_active_users (day);
COMMIT;

-- ── 3. admin_mv_daily_generation_stats ──────────────────────────
BEGIN;
DROP MATERIALIZED VIEW IF EXISTS public.admin_mv_daily_generation_stats CASCADE;
CREATE MATERIALIZED VIEW public.admin_mv_daily_generation_stats AS
  SELECT (date_trunc('day'::text, created_at))::date AS day,
    status,
    count(*) AS generation_count
  FROM generations
  WHERE created_at > (now() - interval '90 days')
  GROUP BY ((date_trunc('day'::text, created_at))::date), status
  ORDER BY ((date_trunc('day'::text, created_at))::date) DESC, status;

CREATE UNIQUE INDEX admin_mv_daily_generation_stats_day_status_idx
  ON public.admin_mv_daily_generation_stats (day, status);
COMMIT;

-- ── 4. admin_mv_daily_job_counts ────────────────────────────────
BEGIN;
DROP MATERIALIZED VIEW IF EXISTS public.admin_mv_daily_job_counts CASCADE;
CREATE MATERIALIZED VIEW public.admin_mv_daily_job_counts AS
  SELECT (date_trunc('day'::text, created_at))::date AS day,
    status,
    count(*) AS job_count
  FROM video_generation_jobs
  WHERE created_at > (now() - interval '90 days')
  GROUP BY ((date_trunc('day'::text, created_at))::date), status
  ORDER BY ((date_trunc('day'::text, created_at))::date) DESC, status;

CREATE UNIQUE INDEX admin_mv_daily_job_counts_day_status_idx
  ON public.admin_mv_daily_job_counts (day, status);
COMMIT;

-- ── 5. admin_mv_daily_revenue ───────────────────────────────────
BEGIN;
DROP MATERIALIZED VIEW IF EXISTS public.admin_mv_daily_revenue CASCADE;
CREATE MATERIALIZED VIEW public.admin_mv_daily_revenue AS
  SELECT (date_trunc('day'::text, created_at))::date AS day,
    count(*)    AS transaction_count,
    sum(amount) AS total_credits_sold
  FROM credit_transactions
  WHERE transaction_type = 'purchase'::text
    AND created_at > (now() - interval '90 days')
  GROUP BY ((date_trunc('day'::text, created_at))::date)
  ORDER BY ((date_trunc('day'::text, created_at))::date) DESC;

CREATE UNIQUE INDEX admin_mv_daily_revenue_day_idx
  ON public.admin_mv_daily_revenue (day);
COMMIT;

-- ── 6. admin_mv_daily_signups ───────────────────────────────────
BEGIN;
DROP MATERIALIZED VIEW IF EXISTS public.admin_mv_daily_signups CASCADE;
CREATE MATERIALIZED VIEW public.admin_mv_daily_signups AS
  SELECT (date_trunc('day'::text, created_at))::date AS day,
    (count(*))::integer AS signups
  FROM auth.users
  WHERE created_at > (now() - interval '90 days')
  GROUP BY ((date_trunc('day'::text, created_at))::date)
  ORDER BY ((date_trunc('day'::text, created_at))::date) DESC;

CREATE UNIQUE INDEX admin_mv_daily_signups_day_idx
  ON public.admin_mv_daily_signups (day);
COMMIT;

-- ── 7. admin_mv_job_perf_daily ──────────────────────────────────
-- Uses finished_at-based filter (not created_at) because this
-- matview groups by date_trunc('day', COALESCE(finished_at,
-- updated_at)). Filtering by COALESCE(finished_at, updated_at)
-- matches what we actually display.
BEGIN;
DROP MATERIALIZED VIEW IF EXISTS public.admin_mv_job_perf_daily CASCADE;
CREATE MATERIALIZED VIEW public.admin_mv_job_perf_daily AS
  SELECT (date_trunc('day'::text, COALESCE(finished_at, updated_at)))::date AS day,
    COALESCE(task_type, 'unknown'::text) AS task_type,
    (percentile_cont((0.50)::double precision) WITHIN GROUP (ORDER BY
      (((EXTRACT(epoch FROM (COALESCE(finished_at, updated_at) - COALESCE(started_at, created_at))) * (1000)::numeric))::double precision)))::numeric AS p50_ms,
    (percentile_cont((0.95)::double precision) WITHIN GROUP (ORDER BY
      (((EXTRACT(epoch FROM (COALESCE(finished_at, updated_at) - COALESCE(started_at, created_at))) * (1000)::numeric))::double precision)))::numeric AS p95_ms,
    (percentile_cont((0.99)::double precision) WITHIN GROUP (ORDER BY
      (((EXTRACT(epoch FROM (COALESCE(finished_at, updated_at) - COALESCE(started_at, created_at))) * (1000)::numeric))::double precision)))::numeric AS p99_ms
  FROM video_generation_jobs
  WHERE status = 'completed'::text
    AND COALESCE(finished_at, updated_at) > (now() - interval '90 days')
  GROUP BY ((date_trunc('day'::text, COALESCE(finished_at, updated_at)))::date),
           COALESCE(task_type, 'unknown'::text)
  ORDER BY ((date_trunc('day'::text, COALESCE(finished_at, updated_at)))::date) DESC,
           COALESCE(task_type, 'unknown'::text);

CREATE UNIQUE INDEX admin_mv_job_perf_daily_day_task_type_idx
  ON public.admin_mv_job_perf_daily (day, task_type);
COMMIT;
