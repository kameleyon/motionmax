-- Fix: process_deletion_requests swallows exceptions and leaves failed requests
-- stuck in 'pending' forever, creating a silent GDPR compliance gap.
-- Note: PostgreSQL's nested BEGIN/EXCEPTION already rolls back partial DML on
-- error (implicit savepoint), so data integrity is preserved. The missing piece
-- is surfacing failures as a 'failed' status so operators can act.

-- 1. Extend the status constraint to allow 'failed'.
ALTER TABLE public.deletion_requests
  DROP CONSTRAINT IF EXISTS deletion_requests_status_check;

ALTER TABLE public.deletion_requests
  ADD CONSTRAINT deletion_requests_status_check
    CHECK (status IN ('pending', 'cancelled', 'completed', 'failed'));

-- 2. Add a column to capture the error reason for failed requests.
ALTER TABLE public.deletion_requests
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- 3. Rewrite the batch function to mark failures instead of swallowing them.
CREATE OR REPLACE FUNCTION public.process_deletion_requests()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  req           RECORD;
  deleted_count INT := 0;
  failed_count  INT := 0;
BEGIN
  FOR req IN
    SELECT id, user_id, email
    FROM deletion_requests
    WHERE status = 'pending'
      AND scheduled_at <= NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      DELETE FROM projects             WHERE user_id = req.user_id;
      DELETE FROM generations          WHERE user_id = req.user_id;
      DELETE FROM subscriptions        WHERE user_id = req.user_id;
      DELETE FROM user_credits         WHERE user_id = req.user_id;
      DELETE FROM credit_transactions  WHERE user_id = req.user_id;
      DELETE FROM generation_costs     WHERE user_id = req.user_id;
      DELETE FROM video_generation_jobs WHERE user_id = req.user_id;
      DELETE FROM auth.users           WHERE id       = req.user_id;

      UPDATE deletion_requests
      SET status = 'completed', error_message = NULL
      WHERE id = req.id;

      deleted_count := deleted_count + 1;

    EXCEPTION WHEN OTHERS THEN
      -- Mark as failed so operators can investigate; data is intact (implicit
      -- savepoint rolls back all DELETEs from this inner block on exception).
      UPDATE deletion_requests
      SET status = 'failed', error_message = SQLERRM
      WHERE id = req.id;

      RAISE WARNING 'Deletion request % (user %) failed: %', req.id, req.user_id, SQLERRM;
      failed_count := failed_count + 1;
    END;
  END LOOP;

  IF deleted_count > 0 OR failed_count > 0 THEN
    RAISE NOTICE 'Deletion run complete: % succeeded, % failed', deleted_count, failed_count;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.process_deletion_requests() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_deletion_requests() TO service_role;
