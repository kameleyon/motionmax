-- ============================================================
-- Migration: Remove dead-code no-op webhook_events branch
-- from process_deletion_request function.
-- The DELETE FROM webhook_events WHERE event_id IN (SELECT ... LIMIT 0)
-- branch is a no-op (webhook_events has no user_id FK) and is misleading
-- in a compliance-critical deletion function.
-- ============================================================

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

  -- 2. Delete database records (cascading FKs handle most child tables)
  -- Note: webhook_events has no user_id FK and does not contain PII;
  -- it is intentionally excluded from user deletion scope.
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

-- Ensure permissions remain locked down
REVOKE ALL ON FUNCTION public.process_deletion_request(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_deletion_request(UUID) TO service_role;
