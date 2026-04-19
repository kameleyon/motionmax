-- Fix: remove 'auth' from SET search_path on process_deletion_request.
-- SECURITY DEFINER functions must not include 'auth' in search_path to
-- prevent shadowing injection (a user-created 'auth' schema could be
-- resolved before the real one). All auth references are already
-- fully-qualified (auth.users), so removing it from the path is safe.

CREATE OR REPLACE FUNCTION public.process_deletion_request(p_request_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'storage'
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
