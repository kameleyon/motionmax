-- Add depends_on column for server-side job dependency tracking.
-- Jobs with depends_on won't be claimed until ALL dependencies complete.

ALTER TABLE public.video_generation_jobs
  ADD COLUMN IF NOT EXISTS depends_on UUID[] DEFAULT '{}';

-- Index for dependency lookups
CREATE INDEX IF NOT EXISTS idx_jobs_depends_on ON public.video_generation_jobs USING GIN (depends_on);

-- Update claim_pending_job to respect dependencies:
-- A job is claimable only if depends_on is empty OR all referenced jobs have status='completed'
CREATE OR REPLACE FUNCTION public.claim_pending_job(
  p_task_type TEXT DEFAULT NULL,
  p_exclude_task_type TEXT DEFAULT NULL
)
RETURNS SETOF public.video_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  claimed_job public.video_generation_jobs;
BEGIN
  -- Find the oldest pending job matching task type criteria
  -- that has all dependencies satisfied (completed)
  SELECT * INTO claimed_job
  FROM public.video_generation_jobs j
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
  ORDER BY j.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  -- If no job found, return empty
  IF claimed_job.id IS NULL THEN
    RETURN;
  END IF;

  -- Atomically mark as processing
  UPDATE public.video_generation_jobs
  SET status = 'processing', updated_at = now()
  WHERE id = claimed_job.id;

  claimed_job.status := 'processing';
  RETURN NEXT claimed_job;
END;
$$;
