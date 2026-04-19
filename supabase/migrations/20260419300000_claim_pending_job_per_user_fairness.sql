-- Per-user job fairness in claim_pending_job.
-- Previously ordered by created_at ASC (pure FIFO), allowing one prolific user
-- to fill the queue and starve others. Now orders by the number of jobs that
-- user already has in 'processing' state (ASC), breaking ties with FIFO.
-- Users with fewer active jobs are served first; within the same active count
-- the oldest job still wins, preserving FIFO semantics for equal users.

CREATE OR REPLACE FUNCTION public.claim_pending_job(
  p_task_type TEXT DEFAULT NULL,
  p_exclude_task_type TEXT DEFAULT NULL
)
RETURNS SETOF public.video_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  claimed_job public.video_generation_jobs;
BEGIN
  SELECT j.* INTO claimed_job
  FROM public.video_generation_jobs j
  -- Count how many jobs this user already has processing (fairness weight)
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS active_count
    FROM public.video_generation_jobs a
    WHERE a.user_id = j.user_id
      AND a.status = 'processing'
  ) active ON true
  WHERE j.status = 'pending'
    AND (p_task_type IS NULL OR j.task_type = p_task_type)
    AND (p_exclude_task_type IS NULL OR j.task_type != p_exclude_task_type)
    AND (
      j.depends_on = '{}'
      OR NOT EXISTS (
        SELECT 1 FROM public.video_generation_jobs dep
        WHERE dep.id = ANY(j.depends_on)
          AND dep.status != 'completed'
      )
    )
  -- Fairness: prefer users with fewer in-flight jobs; FIFO within same weight
  ORDER BY active.active_count ASC, j.created_at ASC
  LIMIT 1
  FOR UPDATE OF j SKIP LOCKED;

  IF claimed_job.id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.video_generation_jobs
  SET status = 'processing', updated_at = now()
  WHERE id = claimed_job.id;

  claimed_job.status := 'processing';
  RETURN NEXT claimed_job;
END;
$$;
