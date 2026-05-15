-- ============================================================
-- Tighten storage-cleanup cadence: monthly → weekly.
-- ============================================================
-- The previous schedule (20260515160000) fired on day 1 of each month.
-- Today's incident showed that orphan accumulation across a 30-day
-- window grew to 37 GB — large enough to push us past the 100 GB cap.
-- Running every Sunday at 02:00 UTC caps the worst-case orphan
-- accumulation to ~1 week of activity.
--
-- The edge function itself (cleanup-intermediate-storage) was also
-- rewritten in this push to (a) recurse into nested folder layouts
-- (scene-videos and videos are <projectId>/<generationId>/...),
-- (b) include the videos/ bucket via composite-policy + orphan
-- sweep, and (c) verify JWT role rather than string-match the
-- service-role key (resilient to key rotation).
--
-- Idempotent: re-running unschedules + rebinds.
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$ BEGIN
  -- Old monthly schedule. Best-effort unschedule, OK if missing.
  BEGIN PERFORM cron.unschedule('monthly-intermediate-storage-cleanup');
  EXCEPTION WHEN OTHERS THEN NULL; END;
  -- And the new name, in case this migration is re-applied.
  BEGIN PERFORM cron.unschedule('weekly-storage-cleanup');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

-- 0 2 * * 0 = 02:00 UTC every Sunday.
SELECT cron.schedule(
  'weekly-storage-cleanup',
  '0 2 * * 0',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/cleanup-intermediate-storage',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key')),
    body := '{}'::jsonb
  )$$
);

COMMIT;
