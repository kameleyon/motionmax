-- Log retention policy for operational log tables.
--
-- Retention targets:
--   system_logs    — 7 days  (high-volume; ~10-20 rows/job, ~600k rows/month)
--   api_call_logs  — 30 days (lower volume; needed for billing/abuse forensics)
--
-- To schedule automatic purges, run this once per project in Supabase SQL editor:
--
--   select cron.schedule(
--     'purge-system-logs',
--     '0 3 * * *',                        -- daily at 03:00 UTC
--     $$ select public.purge_old_system_logs(); $$
--   );
--
--   select cron.schedule(
--     'purge-api-call-logs',
--     '0 3 * * *',                        -- daily at 03:00 UTC
--     $$ select public.purge_old_api_call_logs(); $$
--   );
--
-- Requires the pg_cron extension:
--   create extension if not exists pg_cron;
--
-- purge_old_system_logs() was created in migration 20260419270001.
-- purge_old_api_call_logs() is created here.

CREATE OR REPLACE FUNCTION public.purge_old_api_call_logs()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM api_call_logs
  WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

COMMENT ON FUNCTION public.purge_old_api_call_logs() IS
  'Deletes api_call_logs rows older than 30 days. Schedule daily via pg_cron.';

COMMENT ON FUNCTION public.purge_old_system_logs() IS
  'Deletes system_logs rows older than 7 days. Schedule daily via pg_cron.';
