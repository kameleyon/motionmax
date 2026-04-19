-- Fix search-path injection risk: add SET search_path on the SECURITY DEFINER
-- claim_pending_job function introduced in 20260407000001_job_dependencies.sql.
-- Without this, a schema created before `public` in search_path could shadow
-- public functions and intercept calls made under the function owner's role.

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
