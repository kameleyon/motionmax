-- ============================================================
-- Monthly intermediate-asset storage cleanup.
-- ============================================================
-- Every 1st of the month at 02:00 UTC, fire an HTTP call to the
-- `cleanup-intermediate-storage` edge function. The function
-- walks projects with `updated_at < NOW() - 30 days` and deletes
-- their intermediate scene-images, audio, and scene-videos from
-- storage. The final exported video in the `videos` bucket is
-- never touched, so users keep their export.
--
-- Why an edge function instead of inline SQL: pg_cron can only
-- execute SQL. The Supabase Storage API is HTTP-only — there's
-- no SQL function that mass-deletes storage objects. We follow
-- the same pattern as `run-email-drips` and `drain-deletion-tasks`:
-- pg_cron posts to an edge function via pg_net, the function
-- does the actual work with the service-role key.
--
-- Idempotent: re-running this migration just unschedules + rebinds
-- the cron job. The edge function itself is reentrant — it queries
-- live state every run.
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;
-- pg_net is a Supabase extension already enabled (used by
-- run-email-drips, drain-deletion-tasks). CREATE IF NOT EXISTS so
-- this works on fresh dev databases too.
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('monthly-intermediate-storage-cleanup');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

-- 0 2 1 * * = at 02:00 UTC on the 1st day of every month.
SELECT cron.schedule(
  'monthly-intermediate-storage-cleanup',
  '0 2 1 * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/cleanup-intermediate-storage',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key')),
    body := '{}'::jsonb
  )$$
);

COMMIT;
