-- ============================================================
-- refresh_admin_materialized_views: advisory-lock + bounded timeouts
-- + hourly schedule (was */15)
-- ============================================================
-- Background: on 2026-05-18 the worker started timing out on its
-- terminal UPDATE to video_generation_jobs (canceling statement due
-- to statement timeout). The Realtime channel also flapped with
-- CHANNEL_ERROR in the same minute. Investigation pinned both on
-- the */15 refresh-admin-views cron: at 18:30 UTC one run took 35s,
-- and three minutes later every cron job — including kill-stuck-
-- backends — hit the role statement_timeout. The compute tier
-- (shared_buffers=224MB, work_mem=2MB, max_parallel_workers_per_
-- gather=1) cannot absorb 9 chained REFRESH MATERIALIZED VIEW
-- CONCURRENTLY full-table aggregations every 15 minutes.
--
-- This migration:
--   1. Wraps the refresh in pg_try_advisory_lock so overlapping
--      cron firings (next tick before previous finished) are a
--      no-op instead of stacking up.
--   2. Pins lock_timeout=5s + statement_timeout=120s at the
--      function level so a stuck refresh can never starve the
--      worker beyond its own budget.
--   3. Reschedules the cron from */15 to hourly. Admin dashboard
--      metrics aggregated by day do not need 15-minute freshness.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.refresh_admin_materialized_views()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '120s'
AS $$
DECLARE
  -- Stable 64-bit key for the advisory lock. Any constant works as
  -- long as it does not collide with another lock in this database.
  lock_key constant bigint := hashtextextended('refresh_admin_materialized_views', 0);
BEGIN
  -- Bail out cleanly if a previous refresh is still running. This
  -- replaces the previous behavior where two overlapping refreshes
  -- would each scan every base table and double the IO pressure.
  IF NOT pg_try_advisory_lock(lock_key) THEN
    RAISE NOTICE 'refresh_admin_materialized_views: previous run still in progress, skipping';
    RETURN;
  END IF;

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
  EXCEPTION WHEN OTHERS THEN
    -- Always release the advisory lock, even when one of the
    -- refreshes errors. Re-raise so the cron run is recorded as
    -- failed and the next attempt is not silently masked.
    PERFORM pg_advisory_unlock(lock_key);
    RAISE;
  END;

  PERFORM pg_advisory_unlock(lock_key);
END;
$$;

COMMENT ON FUNCTION public.refresh_admin_materialized_views() IS
  'Refreshes the admin_mv_* dashboard matviews. Guarded by an advisory lock so overlapping cron firings skip rather than stack. Bounded by lock_timeout=5s and statement_timeout=120s. Scheduled hourly via pg_cron job refresh-admin-views.';

-- ── pg_cron schedule: hourly instead of every 15 min ──────────
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('refresh-admin-views');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'refresh-admin-views',
  '0 * * * *',
  $$ SELECT public.refresh_admin_materialized_views(); $$
);

COMMIT;
