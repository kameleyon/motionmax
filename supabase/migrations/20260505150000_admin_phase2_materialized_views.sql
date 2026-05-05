-- ============================================================
-- Admin rebuild — Phase 2.3: five new materialized views
-- ============================================================
-- WHAT: Adds five MVs the admin dashboards consume:
--   * admin_mv_daily_signups        — Analytics signup chart
--   * admin_mv_funnel_weekly        — Analytics funnel + cohorts
--   * admin_mv_project_type_mix     — Analytics top features
--   * admin_mv_api_costs_daily      — API & Costs + Analytics revenue/spend
--   * admin_mv_job_perf_daily       — Performance percentiles
--
-- WHY:  The admin tabs aggregate over multi-million-row tables.
--       Pre-rolled MVs keep the dashboards under 50 ms p95.
--       Each MV gets a unique index so REFRESH CONCURRENTLY
--       can run while reads continue without blocking.
--
-- IMPLEMENTS: ADMIN_REBUILD_CHECKLIST.md section 2.3, plus the
--   refresh_admin_materialized_views() body update so the cron
--   from migration 20260505140000 picks them up.
-- ============================================================

BEGIN;

-- ── 1. admin_mv_daily_signups ────────────────────────────────
-- Rows: (day date, signups int)
-- Source: auth.users.created_at (one row per signup).
CREATE MATERIALIZED VIEW IF NOT EXISTS public.admin_mv_daily_signups AS
SELECT
  date_trunc('day', created_at)::date AS day,
  count(*)::int                       AS signups
FROM auth.users
GROUP BY 1
ORDER BY 1 DESC
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS admin_mv_daily_signups_day_idx
  ON public.admin_mv_daily_signups (day);

-- ── 2. admin_mv_funnel_weekly ────────────────────────────────
-- Rows: (cohort_week date, signups int, projects int, generations int, paid int)
-- Source: auth.users (cohort), projects (project create), generations
-- (any generation), subscriptions (any non-free subscription) keyed
-- to the user's cohort week. Numbers are cumulative inside the cohort.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.admin_mv_funnel_weekly AS
WITH cohorts AS (
  SELECT
    u.id                                                   AS user_id,
    date_trunc('week', u.created_at)::date                 AS cohort_week
  FROM auth.users u
),
proj AS (
  SELECT DISTINCT user_id FROM public.projects
),
gens AS (
  SELECT DISTINCT user_id FROM public.generations
),
paid AS (
  SELECT DISTINCT user_id
  FROM public.subscriptions
  WHERE plan_name IS NOT NULL
    AND COALESCE(plan_name, 'free') <> 'free'
)
SELECT
  c.cohort_week,
  count(*)::int                                                AS signups,
  count(*) FILTER (WHERE p.user_id IS NOT NULL)::int           AS projects,
  count(*) FILTER (WHERE g.user_id IS NOT NULL)::int           AS generations,
  count(*) FILTER (WHERE pd.user_id IS NOT NULL)::int          AS paid
FROM cohorts c
LEFT JOIN proj p  ON p.user_id  = c.user_id
LEFT JOIN gens g  ON g.user_id  = c.user_id
LEFT JOIN paid pd ON pd.user_id = c.user_id
GROUP BY 1
ORDER BY 1 DESC
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS admin_mv_funnel_weekly_cohort_week_idx
  ON public.admin_mv_funnel_weekly (cohort_week);

-- ── 3. admin_mv_project_type_mix ─────────────────────────────
-- Rows: (project_type text, count int, last_7d int, last_30d int)
-- Source: projects.format coalesced through project_type if present.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.admin_mv_project_type_mix AS
SELECT
  COALESCE(p.format, 'unknown')                                                  AS project_type,
  count(*)::int                                                                  AS count,
  count(*) FILTER (WHERE p.created_at > now() - interval '7 days')::int          AS last_7d,
  count(*) FILTER (WHERE p.created_at > now() - interval '30 days')::int         AS last_30d
FROM public.projects p
GROUP BY 1
ORDER BY 2 DESC
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS admin_mv_project_type_mix_project_type_idx
  ON public.admin_mv_project_type_mix (project_type);

-- ── 4. admin_mv_api_costs_daily ──────────────────────────────
-- Rows: (day date, provider text, model text, status text,
--        calls int, spend numeric, avg_ms numeric)
-- Source: api_call_logs.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.admin_mv_api_costs_daily AS
SELECT
  date_trunc('day', created_at)::date            AS day,
  COALESCE(provider, 'unknown')                  AS provider,
  COALESCE(model, 'unknown')                     AS model,
  COALESCE(status, 'unknown')                    AS status,
  count(*)::int                                  AS calls,
  COALESCE(sum(cost), 0)::numeric                AS spend,
  COALESCE(avg(total_duration_ms), 0)::numeric   AS avg_ms
FROM public.api_call_logs
GROUP BY 1, 2, 3, 4
ORDER BY 1 DESC, 2, 3, 4
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS admin_mv_api_costs_daily_day_provider_model_status_idx
  ON public.admin_mv_api_costs_daily (day, provider, model, status);

-- ── 5. admin_mv_job_perf_daily ───────────────────────────────
-- Rows: (day date, task_type text, p50_ms numeric, p95_ms numeric,
--        p99_ms numeric)
-- Source: video_generation_jobs (started_at + finished_at columns
-- are added in migration 20260505160000; this MV expects them).
CREATE MATERIALIZED VIEW IF NOT EXISTS public.admin_mv_job_perf_daily AS
SELECT
  date_trunc('day', COALESCE(finished_at, updated_at))::date                                                                           AS day,
  COALESCE(task_type, 'unknown')                                                                                                       AS task_type,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE(finished_at, updated_at) - COALESCE(started_at, created_at))) * 1000)::numeric AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE(finished_at, updated_at) - COALESCE(started_at, created_at))) * 1000)::numeric AS p95_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE(finished_at, updated_at) - COALESCE(started_at, created_at))) * 1000)::numeric AS p99_ms
FROM public.video_generation_jobs
WHERE status = 'completed'
GROUP BY 1, 2
ORDER BY 1 DESC, 2
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS admin_mv_job_perf_daily_day_task_type_idx
  ON public.admin_mv_job_perf_daily (day, task_type);

-- ── 6. Lock down direct API access ───────────────────────────
-- MVs cannot carry RLS; gate them via wrapper RPCs. Revoke all
-- access from anon/authenticated so non-admin clients cannot
-- pull these via the Data API.
REVOKE ALL ON public.admin_mv_daily_signups       FROM anon, authenticated;
REVOKE ALL ON public.admin_mv_funnel_weekly       FROM anon, authenticated;
REVOKE ALL ON public.admin_mv_project_type_mix    FROM anon, authenticated;
REVOKE ALL ON public.admin_mv_api_costs_daily     FROM anon, authenticated;
REVOKE ALL ON public.admin_mv_job_perf_daily      FROM anon, authenticated;

-- ── 7. Update refresh_admin_materialized_views() ─────────────
-- Adds REFRESH CONCURRENTLY for the 5 new MVs to the existing
-- function from 20260419250000_admin_materialized_views.sql.
CREATE OR REPLACE FUNCTION public.refresh_admin_materialized_views()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_daily_active_users;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_daily_revenue;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_daily_job_counts;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_daily_generation_stats;

  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_daily_signups;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_funnel_weekly;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_project_type_mix;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_api_costs_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.admin_mv_job_perf_daily;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_admin_materialized_views() FROM anon, authenticated;

COMMIT;
