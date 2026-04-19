-- Add worker_id column so each replica stamps the jobs it owns.
-- This allows startup recovery to scope resets to "my own stale rows"
-- rather than blindly resetting all processing rows across every replica.

ALTER TABLE public.video_generation_jobs
  ADD COLUMN IF NOT EXISTS worker_id TEXT DEFAULT NULL;

-- Index speeds up the startup-diagnostic query (WHERE worker_id = $1 AND status = 'processing')
CREATE INDEX IF NOT EXISTS idx_jobs_worker_id ON public.video_generation_jobs (worker_id)
  WHERE worker_id IS NOT NULL;

-- Replace claim_pending_job: accept p_worker_id so the RPC stamps claimed rows.
CREATE OR REPLACE FUNCTION public.claim_pending_job(
  p_task_type TEXT DEFAULT NULL,
  p_exclude_task_type TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 1,
  p_worker_id TEXT DEFAULT NULL
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
  SET status = 'processing', updated_at = NOW(), worker_id = p_worker_id
  FROM to_claim
  WHERE j.id = to_claim.id
  RETURNING j.*;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_pending_job(TEXT, TEXT, INTEGER, TEXT) TO service_role;
-- Keep old 3-arg signature working (worker_id defaults to NULL)
GRANT EXECUTE ON FUNCTION public.claim_pending_job(TEXT, TEXT, INTEGER) TO service_role;
