-- ============================================================
-- Admin rebuild — Phase 2.1 + 2.2: pg_cron schedules
-- ============================================================
-- WHAT: Schedules four background jobs that already have their
--       SQL functions defined elsewhere but were never wired into
--       cron, so they currently never run on the live DB.
--
-- WHY:  The admin dashboards depend on materialized views being
--       fresh (every 15 min) and on the operational log tables
--       being trimmed nightly so they don't grow unbounded.
--
-- IMPLEMENTS: ADMIN_REBUILD_CHECKLIST.md sections 2.1 + 2.2.
--
-- IDEMPOTENCY: each cron.schedule call is preceded by a guarded
--   cron.unschedule of any existing job with the same name. The
--   unschedule is wrapped in a DO block with EXCEPTION OTHERS so
--   re-running this migration is safe.
-- ============================================================

BEGIN;

-- pg_cron must be available; on Supabase Pro this is preinstalled.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── Helper: unschedule a job by name if it exists ────────────
DO $$
BEGIN
  -- refresh-admin-views (every 15 min)
  BEGIN
    PERFORM cron.unschedule('refresh-admin-views');
  EXCEPTION WHEN OTHERS THEN
    -- job did not exist; nothing to do
    NULL;
  END;

  BEGIN
    PERFORM cron.unschedule('purge-system-logs');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    PERFORM cron.unschedule('purge-api-call-logs');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    PERFORM cron.unschedule('purge-dead-letter-jobs');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

-- ── 1. Refresh admin materialized views every 15 min ─────────
SELECT cron.schedule(
  'refresh-admin-views',
  '*/15 * * * *',
  $$ SELECT public.refresh_admin_materialized_views(); $$
);

-- ── 2. Purge system_logs daily at 03:00 UTC ──────────────────
SELECT cron.schedule(
  'purge-system-logs',
  '0 3 * * *',
  $$ SELECT public.purge_old_system_logs(); $$
);

-- ── 3. Purge api_call_logs daily at 03:00 UTC ────────────────
SELECT cron.schedule(
  'purge-api-call-logs',
  '0 3 * * *',
  $$ SELECT public.purge_old_api_call_logs(); $$
);

-- ── 4. Purge dead-letter jobs daily at 03:30 UTC ─────────────
SELECT cron.schedule(
  'purge-dead-letter-jobs',
  '30 3 * * *',
  $$ SELECT public.purge_old_dead_letter_jobs(); $$
);

COMMIT;
