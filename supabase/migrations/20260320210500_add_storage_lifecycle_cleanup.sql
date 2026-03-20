-- Storage lifecycle cleanup (Part 3.4)
-- Adds a database function to clean up old storage objects
-- This function is called via pg_cron or a scheduled script

-- Function: delete storage objects older than a retention period
CREATE OR REPLACE FUNCTION public.cleanup_old_storage_objects(
  bucket text,
  retention_days int DEFAULT 30
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count int := 0;
BEGIN
  WITH expired AS (
    DELETE FROM storage.objects
    WHERE bucket_id = bucket
      AND created_at < (now() - (retention_days || ' days')::interval)
    RETURNING id
  )
  SELECT count(*) INTO deleted_count FROM expired;

  RETURN deleted_count;
END;
$$;

-- Restrict to service_role only
REVOKE ALL ON FUNCTION public.cleanup_old_storage_objects(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_old_storage_objects(text, int) FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_old_storage_objects(text, int) FROM authenticated;

-- Enable pg_cron extension if not already enabled (requires superuser)
-- Note: On Supabase hosted, pg_cron is enabled via the dashboard.
-- The following scheduled jobs should be configured via the Supabase SQL editor:
--
-- SELECT cron.schedule(
--   'cleanup-videos-30d',
--   '0 3 * * *',  -- daily at 3 AM UTC
--   $$SELECT public.cleanup_old_storage_objects('videos', 30)$$
-- );
--
-- SELECT cron.schedule(
--   'cleanup-audio-60d',
--   '0 3 * * *',
--   $$SELECT public.cleanup_old_storage_objects('audio', 60)$$
-- );
