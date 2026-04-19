-- ============================================================
-- Admin Materialized Views
-- Pre-aggregates expensive dashboard queries that previously
-- ran ad-hoc in admin-stats/index.ts, loading full tables
-- into edge-function memory.
--
-- Security: materialized views cannot carry RLS, so we revoke
-- access from the anon and authenticated roles. Only the
-- service_role (used by the admin-stats edge function) retains
-- SELECT. This mirrors the advice in the Supabase security docs
-- for tables/views that must bypass RLS but should never be
-- reachable through the Data API.
-- ============================================================

-- ── 1. DAILY ACTIVE USERS ────────────────────────────────────
-- Unique users who started at least one generation per calendar day.
CREATE MATERIALIZED VIEW public.admin_mv_daily_active_users AS
SELECT
  date_trunc('day', created_at)::date AS day,
  count(DISTINCT user_id)             AS active_users
FROM public.generations
GROUP BY 1
ORDER BY 1 DESC
WITH DATA;

CREATE UNIQUE INDEX admin_mv_daily_active_users_day_idx
  ON public.admin_mv_daily_active_users (day);

-- ── 2. DAILY REVENUE (credit purchase transactions) ──────────
-- Aggregates credit_transactions of type 'purchase' per day.
-- Note: does NOT include Stripe subscription charges, which live
-- outside Postgres. This covers in-app credit pack revenue only.
CREATE MATERIALIZED VIEW public.admin_mv_daily_revenue AS
SELECT
  date_trunc('day', created_at)::date AS day,
  count(*)                            AS transaction_count,
  sum(amount)                         AS total_credits_sold
FROM public.credit_transactions
WHERE transaction_type = 'purchase'
GROUP BY 1
ORDER BY 1 DESC
WITH DATA;

CREATE UNIQUE INDEX admin_mv_daily_revenue_day_idx
  ON public.admin_mv_daily_revenue (day);

-- ── 3. DAILY JOB COUNTS (video_generation_jobs) ──────────────
-- Job throughput per day broken down by status. Useful for
-- spotting worker backlogs or error spikes on the admin dashboard.
CREATE MATERIALIZED VIEW public.admin_mv_daily_job_counts AS
SELECT
  date_trunc('day', created_at)::date AS day,
  status,
  count(*)                            AS job_count
FROM public.video_generation_jobs
GROUP BY 1, 2
ORDER BY 1 DESC, 2
WITH DATA;

CREATE UNIQUE INDEX admin_mv_daily_job_counts_day_status_idx
  ON public.admin_mv_daily_job_counts (day, status);

-- ── 4. DAILY GENERATION STATS ────────────────────────────────
-- Generation counts per day and status, covering the active
-- (non-archived) table only. Combine with generation_archives
-- for historical totals when needed.
CREATE MATERIALIZED VIEW public.admin_mv_daily_generation_stats AS
SELECT
  date_trunc('day', created_at)::date AS day,
  status,
  count(*)                            AS generation_count
FROM public.generations
GROUP BY 1, 2
ORDER BY 1 DESC, 2
WITH DATA;

CREATE UNIQUE INDEX admin_mv_daily_generation_stats_day_status_idx
  ON public.admin_mv_daily_generation_stats (day, status);

-- ── 5. LOCK DOWN ACCESS ──────────────────────────────────────
-- Revoke from roles exposed through the Data API so these views
-- are never reachable via anon/authenticated JWT requests.
REVOKE ALL ON public.admin_mv_daily_active_users      FROM anon, authenticated;
REVOKE ALL ON public.admin_mv_daily_revenue           FROM anon, authenticated;
REVOKE ALL ON public.admin_mv_daily_job_counts        FROM anon, authenticated;
REVOKE ALL ON public.admin_mv_daily_generation_stats  FROM anon, authenticated;

-- ── 6. REFRESH FUNCTION ──────────────────────────────────────
-- Call this from a pg_cron job (see comment below) or manually
-- after bulk data imports. CONCURRENTLY requires the unique
-- indexes above so reads are not blocked during refresh.
CREATE OR REPLACE FUNCTION public.refresh_admin_materialized_views()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_daily_active_users;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_daily_revenue;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_daily_job_counts;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_daily_generation_stats;
END;
$$;

-- Restrict execution to service_role / postgres only.
REVOKE ALL ON FUNCTION public.refresh_admin_materialized_views() FROM anon, authenticated;

-- ── 7. SCHEDULE NIGHTLY REFRESH VIA pg_cron ──────────────────
-- pg_cron is available on Supabase Pro. Schedule a refresh at
-- 02:00 UTC each night so the dashboard reads pre-built data.
-- Enable with: SELECT cron.schedule(...) in the SQL editor or
-- uncomment the block below once pg_cron is enabled on the project.
--
-- SELECT cron.schedule(
--   'refresh-admin-views',
--   '0 2 * * *',
--   $$ SELECT public.refresh_admin_materialized_views(); $$
-- );
