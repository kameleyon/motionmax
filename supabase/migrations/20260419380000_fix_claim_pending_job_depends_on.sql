-- Fix claim_pending_job (4-arg) to enforce depends_on and add per-user fairness.
--
-- The previous 4-arg overload (from 20260419120000) had NO depends_on check,
-- so cinematic_video jobs were claimed before their image dependencies finished.
-- This caused the 90s polling loop in handleCinematicVideo to fire every time.
--
-- The 2-arg overload (from 20260419300000) had depends_on but no p_limit/p_worker_id,
-- so the worker never called it.
--
-- This migration unifies both: depends_on enforcement + fairness + bulk claim.

CREATE OR REPLACE FUNCTION public.claim_pending_job(
  p_task_type        TEXT    DEFAULT NULL,
  p_exclude_task_type TEXT   DEFAULT NULL,
  p_limit            INTEGER DEFAULT 1,
  p_worker_id        TEXT    DEFAULT NULL
)
RETURNS SETOF public.video_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  WITH to_claim AS (
    SELECT j.id,
      (
        SELECT COUNT(*)
        FROM public.video_generation_jobs a
        WHERE a.user_id = j.user_id AND a.status = 'processing'
      ) AS active_count
    FROM public.video_generation_jobs j
    WHERE j.status = 'pending'
      AND (p_task_type IS NULL OR j.task_type = p_task_type)
      AND (p_exclude_task_type IS NULL OR j.task_type != p_exclude_task_type)
      -- Dependency gate: only claim when all depends_on jobs are completed
      AND (
        j.depends_on = '{}'
        OR NOT EXISTS (
          SELECT 1 FROM public.video_generation_jobs dep
          WHERE dep.id = ANY(j.depends_on)
            AND dep.status != 'completed'
        )
      )
    ORDER BY active_count ASC, j.created_at ASC
    LIMIT p_limit
    FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE public.video_generation_jobs j
  SET status = 'processing', updated_at = NOW(), worker_id = p_worker_id
  FROM to_claim
  WHERE j.id = to_claim.id
  RETURNING j.*;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_pending_job(TEXT, TEXT, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pending_job(TEXT, TEXT, INTEGER) TO service_role;
