-- ============================================================
-- C-9-9: Consolidate system_logs retention crons
--
-- Three overlapping retention specs were active for `system_logs`:
--   1. 20260404000005_data_retention_and_cleanup.sql
--      - Defined purge_old_system_logs() with INTERVAL '90 days'
--      - Scheduled `daily-data-retention` cron calling run_data_retention()
--        which in turn invokes purge_old_system_logs()
--   2. 20260419270001_reduce_system_logs_retention.sql
--      - Redefined purge_old_system_logs() with INTERVAL '7 days'
--   3. 20260505140000_admin_phase2_cron_schedules.sql
--      - Scheduled `purge-system-logs` cron calling purge_old_system_logs()
--        directly (in addition to the daily-data-retention cron from step 1)
--
-- Result: two crons racing against each other, one of which calls a
-- function whose definition was rewritten mid-deploy. Behavior depends
-- on apply-order and which cron fires first on the day — neither is
-- safe.
--
-- This migration:
--   - cron.unschedule()s both the 'purge-system-logs' and
--     'daily-data-retention' jobs (best-effort; missing job is a NOOP).
--   - Redefines purge_old_system_logs() with the chosen window.
--   - Reschedules exactly ONE cron job: 'system-logs-retention',
--     calling purge_old_system_logs() directly.
--
-- ── Retention decision: 30 days ──
-- 90 days was the original spec, optimized for forensic audit needs but
-- expensive at ~600k rows/month (~5GB/quarter).
-- 7 days was the panic-reduce, optimized for cost but kills almost all
-- post-incident investigation capability (Sentry only keeps 30d on
-- the team plan, so 7d of system_logs means the trail goes cold).
-- 30 days is the chosen compromise: it covers Sentry's retention window
-- so cross-referencing always has both ends of the trace, and it caps
-- table size at ~2GB which is well within the Pro plan's storage tier.
-- Documented here so the next person doesn't redo the same debate.
-- ============================================================

BEGIN;

-- 1. Drop the conflicting cron jobs. Each is wrapped in its own DO
-- block with EXCEPTION OTHERS so a missing job (e.g. on a DB that
-- never had the older migrations applied) doesn't fail the whole
-- migration. cron.unschedule raises when the job doesn't exist.
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('purge-system-logs');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  BEGIN
    PERFORM cron.unschedule('daily-data-retention');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  BEGIN
    PERFORM cron.unschedule('system-logs-retention');
  EXCEPTION WHEN OTHERS THEN
    -- Idempotency: drop our own previous schedule if rerunning
    NULL;
  END;
END $$;

-- 2. Redefine purge_old_system_logs() with the canonical 30d window.
-- Replaces the 90-day (20260404) and 7-day (20260419) definitions.
CREATE OR REPLACE FUNCTION public.purge_old_system_logs()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted INT;
BEGIN
  -- 30 days: see migration header for rationale (covers Sentry's
  -- retention window, caps table size at ~2GB).
  DELETE FROM system_logs
   WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

COMMENT ON FUNCTION public.purge_old_system_logs() IS
  'Deletes system_logs rows older than 30 days. See migration 20260510250300 for retention-window rationale.';

-- 3. Schedule the single canonical retention cron.
SELECT cron.schedule(
  'system-logs-retention',
  '0 3 * * *',                              -- daily at 03:00 UTC
  $$ SELECT public.purge_old_system_logs(); $$
);

-- 4. Re-add the OTHER retention jobs that the dropped
-- 'daily-data-retention' cron used to drive — they are still
-- legitimately scheduled by 20260505140000 but the master function
-- run_data_retention() also called purge_old_archives,
-- purge_old_jobs, purge_old_webhook_events, process_due_deletions.
-- Move those to their own dedicated cron jobs so the retention
-- of one table can never affect another table.
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('archives-retention');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN
    PERFORM cron.unschedule('jobs-retention');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN
    PERFORM cron.unschedule('webhook-events-retention');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN
    PERFORM cron.unschedule('deletion-requests-processor');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'archives-retention',
  '15 3 * * *',
  $$ SELECT public.purge_old_archives(); $$
);
SELECT cron.schedule(
  'jobs-retention',
  '30 3 * * *',
  $$ SELECT public.purge_old_jobs(); $$
);
SELECT cron.schedule(
  'webhook-events-retention',
  '45 3 * * *',
  $$ SELECT public.purge_old_webhook_events(); $$
);
SELECT cron.schedule(
  'deletion-requests-processor',
  '0 4 * * *',
  $$ SELECT public.process_due_deletions(); $$
);

COMMIT;
