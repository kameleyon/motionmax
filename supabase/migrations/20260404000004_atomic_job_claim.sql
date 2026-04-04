-- Atomic job claim: SELECT FOR UPDATE SKIP LOCKED prevents duplicate pickup
CREATE OR REPLACE FUNCTION public.claim_pending_job(
  p_task_type TEXT DEFAULT NULL,
  p_exclude_task_type TEXT DEFAULT NULL
)
RETURNS SETOF public.video_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  claimed_job video_generation_jobs%ROWTYPE;
BEGIN
  -- Atomically find and claim the oldest pending job matching criteria
  IF p_task_type IS NOT NULL THEN
    SELECT * INTO claimed_job
    FROM video_generation_jobs
    WHERE status = 'pending' AND task_type = p_task_type
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  ELSIF p_exclude_task_type IS NOT NULL THEN
    SELECT * INTO claimed_job
    FROM video_generation_jobs
    WHERE status = 'pending' AND task_type != p_exclude_task_type
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  ELSE
    SELECT * INTO claimed_job
    FROM video_generation_jobs
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
  END IF;

  IF claimed_job.id IS NULL THEN
    RETURN; -- no rows
  END IF;

  -- Mark as processing atomically within the same transaction
  UPDATE video_generation_jobs
  SET status = 'processing', updated_at = NOW()
  WHERE id = claimed_job.id;

  -- Return the claimed job with its original data
  claimed_job.status := 'processing';
  RETURN NEXT claimed_job;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_pending_job(TEXT, TEXT) TO service_role;
