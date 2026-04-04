-- ============================================================
-- 6.2: Storage cleanup on user deletion
-- Enhance the deletion pipeline to clean storage files
-- ============================================================

-- The trigger_cleanup_user_storage (from migration 000003) handles
-- auth.users DELETE. This migration adds a function specifically for
-- the deletion_requests workflow, which processes scheduled deletions.

CREATE OR REPLACE FUNCTION public.process_deletion_request(p_request_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'storage', 'auth'
AS $$
DECLARE
  v_user_id UUID;
  v_email TEXT;
  bucket_name TEXT;
  buckets TEXT[] := ARRAY['scene-images', 'scene-videos', 'audio', 'videos', 'voice-samples'];
  deleted_files INT := 0;
  file_count INT;
BEGIN
  -- Get the deletion request
  SELECT user_id, email INTO v_user_id, v_email
  FROM deletion_requests
  WHERE id = p_request_id AND status = 'pending';

  IF v_user_id IS NULL THEN
    RAISE WARNING 'Deletion request % not found or not pending', p_request_id;
    RETURN FALSE;
  END IF;

  -- 1. Delete storage objects across all buckets
  FOREACH bucket_name IN ARRAY buckets
  LOOP
    DELETE FROM storage.objects
    WHERE bucket_id = bucket_name
      AND (
        name LIKE v_user_id::text || '/%'
        OR name LIKE '%/' || v_user_id::text || '/%'
      );
    GET DIAGNOSTICS file_count = ROW_COUNT;
    deleted_files := deleted_files + file_count;
  END LOOP;

  -- 2. Delete database records (cascading FKs handle most tables)
  -- Explicitly delete tables that may not have FK to auth.users
  DELETE FROM webhook_events WHERE event_id IN (
    SELECT event_id FROM webhook_events LIMIT 0 -- no-op, webhook_events don't have user_id
  );

  -- Delete the user from auth.users (cascading FKs clean up the rest)
  DELETE FROM auth.users WHERE id = v_user_id;

  -- 3. Mark deletion request as completed
  UPDATE deletion_requests
  SET status = 'completed'
  WHERE id = p_request_id;

  RAISE NOTICE 'User % deleted: % storage files removed', v_user_id, deleted_files;
  RETURN TRUE;

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Deletion of user % failed: %', v_user_id, SQLERRM;
    RETURN FALSE;
END;
$$;

-- Function to process all due deletion requests
CREATE OR REPLACE FUNCTION public.process_due_deletions()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  req RECORD;
  processed INT := 0;
BEGIN
  FOR req IN
    SELECT id FROM deletion_requests
    WHERE status = 'pending'
      AND scheduled_at <= NOW()
    ORDER BY scheduled_at ASC
    LIMIT 50  -- batch size
  LOOP
    IF process_deletion_request(req.id) THEN
      processed := processed + 1;
    END IF;
  END LOOP;

  RETURN processed;
END;
$$;


-- ============================================================
-- 6.3: Automated data retention policies
-- Purge old data to control storage costs and comply with
-- data minimization principles.
-- ============================================================

-- Purge system_logs older than 90 days
CREATE OR REPLACE FUNCTION public.purge_old_system_logs()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM system_logs
  WHERE created_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- Purge generation_archives older than 1 year
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
  WHERE archived_at < NOW() - INTERVAL '1 year';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- Purge completed/failed job records older than 30 days
CREATE OR REPLACE FUNCTION public.purge_old_jobs()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM video_generation_jobs
  WHERE status IN ('completed', 'failed')
    AND updated_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- Purge old webhook events (idempotency records) older than 7 days
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
  WHERE created_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- Master retention function — call this on a schedule (e.g. daily via pg_cron)
CREATE OR REPLACE FUNCTION public.run_data_retention()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  logs_deleted INT;
  archives_deleted INT;
  jobs_deleted INT;
  webhooks_deleted INT;
  deletions_processed INT;
BEGIN
  logs_deleted := purge_old_system_logs();
  archives_deleted := purge_old_archives();
  jobs_deleted := purge_old_jobs();
  webhooks_deleted := purge_old_webhook_events();
  deletions_processed := process_due_deletions();

  RETURN jsonb_build_object(
    'system_logs_purged', logs_deleted,
    'archives_purged', archives_deleted,
    'jobs_purged', jobs_deleted,
    'webhook_events_purged', webhooks_deleted,
    'deletions_processed', deletions_processed,
    'ran_at', NOW()
  );
END;
$$;

-- Schedule via pg_cron if available (Supabase Pro plan)
-- Run daily at 3 AM UTC
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'daily-data-retention',
      '0 3 * * *',
      $cron$SELECT public.run_data_retention()$cron$
    );
  ELSE
    RAISE NOTICE 'pg_cron not available — run_data_retention() must be called manually or via external scheduler';
  END IF;
END $$;
