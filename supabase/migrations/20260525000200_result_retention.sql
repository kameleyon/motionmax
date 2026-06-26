-- ============================================================
-- Public-API result retention: generated-videos bucket.
-- ============================================================
-- Roadmap §Phase 3 (Builder D — Result Retention).
--
-- Published retention window: result video assets in the
-- 'generated-videos' bucket are retained for 30 days from upload.
-- After that the object is purged from storage and the GET
-- /api/v1/videos/{id} read path surfaces public state 'expired'
-- with video_url null (computed from created_at + the same window;
-- see api/v1/videos/[id]/index.ts RETENTION_DAYS).
--
-- This migration schedules a DAILY pg_cron job that invokes the
-- existing SECURITY DEFINER helper
--   public.cleanup_old_storage_objects('generated-videos', 30)
-- directly in SQL (no http / edge function hop required — the helper
-- deletes from storage.objects itself). cron jobs run as the table
-- owner, so the SECURITY DEFINER function is callable without the
-- service-role key / Vault dance used by http-based crons.
--
-- Idempotent: re-running unschedules the job (best-effort) then
-- re-schedules it. CREATE EXTENSION ... IF NOT EXISTS mirrors
-- 20260515170000_storage_cleanup_weekly.sql.
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Published retention window for API result videos. Keep in lockstep
-- with RETENTION_DAYS in api/v1/videos/[id]/index.ts (30 days). The
-- cron purge and the read-path 'expired' computation MUST agree so a
-- caller never sees a live video_url for an object the purge removed.
DO $$
DECLARE
  retention_days constant int := 30;
BEGIN
  -- Best-effort unschedule so this migration is safe to re-apply.
  BEGIN
    PERFORM cron.unschedule('generated-videos-retention');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- 0 3 * * * = 03:00 UTC daily. Calls the SECURITY DEFINER cleanup
  -- helper directly; it deletes storage.objects in 'generated-videos'
  -- older than `retention_days` and returns the deleted count.
  PERFORM cron.schedule(
    'generated-videos-retention',
    '0 3 * * *',
    format(
      $cmd$SELECT public.cleanup_old_storage_objects('generated-videos', %s);$cmd$,
      retention_days
    )
  );
END $$;

COMMIT;
