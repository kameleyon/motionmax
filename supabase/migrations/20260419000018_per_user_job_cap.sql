-- Per-user job concurrency cap: prevent a single user from saturating all
-- worker slots by skipping jobs whose owner already has 3+ processing jobs.
-- Replaces the bulk atomic claim added in 20260418151024_atomic_job_claim_bulk.sql.

CREATE OR REPLACE FUNCTION public.claim_pending_job(
  p_task_type TEXT DEFAULT NULL,
  p_exclude_task_type TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 1
)
RETURNS SETOF public.video_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH to_claim AS (
    SELECT pj.id
    FROM public.video_generation_jobs pj
    WHERE pj.status = 'pending'
      AND (p_task_type IS NULL OR pj.task_type = p_task_type)
      AND (p_exclude_task_type IS NULL OR pj.task_type != p_exclude_task_type)
      -- Per-user cap: skip jobs for users who already have 3+ processing jobs
      AND (
        pj.user_id IS NULL
        OR (
          SELECT COUNT(*)
          FROM public.video_generation_jobs
          WHERE user_id = pj.user_id
            AND status = 'processing'
        ) < 3
      )
    ORDER BY pj.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.video_generation_jobs j
  SET status = 'processing', updated_at = NOW()
  FROM to_claim
  WHERE j.id = to_claim.id
  RETURNING j.*;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_pending_job(TEXT, TEXT, INTEGER) TO service_role;
