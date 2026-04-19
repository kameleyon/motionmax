-- Fix purge_old_archives: generation_archives has deleted_at, not archived_at.
-- Fix purge_old_webhook_events: webhook_events has processed_at, not created_at.

CREATE OR REPLACE FUNCTION public.purge_old_archives()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM generation_archives
  WHERE deleted_at < NOW() - INTERVAL '1 year';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_old_webhook_events()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM webhook_events
  WHERE processed_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
