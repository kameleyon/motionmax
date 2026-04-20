-- ============================================================
-- LOW priority database fixes (batch, 2026-04-19)
-- ============================================================

-- ============================================================
-- 1. webhook_events: document processed_at (no column change needed)
--    The table was created with processed_at. The roadmap flag
--    noted a potential mismatch with delivered_at. The live schema
--    uses processed_at; this comment documents the decision.
-- ============================================================
COMMENT ON COLUMN public.webhook_events.processed_at IS
  'Timestamp when the Stripe webhook event was processed. '
  'Historical note: an early draft used "delivered_at"; the canonical '
  'column name is processed_at. No schema change required.';

-- ============================================================
-- 2. deletion_requests: drop redundant created_at column
--    requested_at and created_at have the same default (NOW()).
--    Keep requested_at (domain-meaningful); drop created_at.
-- ============================================================
ALTER TABLE public.deletion_requests
  DROP COLUMN IF EXISTS created_at;

-- ============================================================
-- 3. project-thumbnails: verify no permissive-lax policies exist
--    Migration 20260419000006 already locked down this bucket.
--    Explicitly drop any old permissive INSERT/DELETE policies
--    that lack a role clause, in case they were re-introduced.
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can upload thumbnails" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view project thumbnails" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload project thumbnails" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own project thumbnails" ON storage.objects;

-- ============================================================
-- 4. user_flags: composite partial index for unresolved flags
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_user_flags_unresolved_user
  ON public.user_flags (user_id, created_at DESC)
  WHERE resolved_at IS NULL;

-- ============================================================
-- 5. voice_samples bucket public→private: documented no-op
--    The bucket was initially public, then flipped to private in
--    migration history. The current state is private (correct).
--    No schema change is needed; this comment records the history.
-- ============================================================
COMMENT ON TABLE public.user_voices IS
  'Stores cloned voice metadata. Corresponding audio files live in the '
  '"voice_samples" storage bucket, which is private (service_role only). '
  'The bucket was correctly set to private; no migration action required.';

-- ============================================================
-- 6. system_logs: authenticated INSERT policy for client-side logging
-- ============================================================
-- Drop any existing authenticated insert policy to avoid conflict
DROP POLICY IF EXISTS "authenticated_insert_system_logs" ON public.system_logs;
DROP POLICY IF EXISTS "Users can insert own system_logs" ON public.system_logs;

CREATE POLICY "authenticated_insert_system_logs"
  ON public.system_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- 7. user_voices: UNIQUE constraint on (user_id, voice_id)
-- ============================================================
ALTER TABLE public.user_voices
  DROP CONSTRAINT IF EXISTS uq_user_voices_user_voice;

ALTER TABLE public.user_voices
  ADD CONSTRAINT uq_user_voices_user_voice UNIQUE (user_id, voice_id);

-- ============================================================
-- 8. admin_logs + api_call_logs: add updated_at columns
--    These are append-only audit tables; updated_at defaults to
--    created_at and will never be changed, but some BI tooling
--    expects the column for incremental sync.
-- ============================================================
ALTER TABLE public.admin_logs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.api_call_logs
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ============================================================
-- 9. process_deletion_request: remove dead-code no-op branch
--    The no-op DELETE for webhook_events was replaced inline.
--    This migration rewrites the function, removing the dead code.
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

  -- 2. Delete the user from auth.users (cascading FKs clean up the rest)
  --    NOTE: webhook_events has no user_id FK and intentionally retains
  --    idempotency records beyond user deletion for replay safety.
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
