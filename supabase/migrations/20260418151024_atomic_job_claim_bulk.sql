-- Bulk atomic job claim: SELECT FOR UPDATE SKIP LOCKED prevents duplicate pickup
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
    SELECT id
    FROM public.video_generation_jobs
    WHERE status = 'pending'
      AND (p_task_type IS NULL OR task_type = p_task_type)
      AND (p_exclude_task_type IS NULL OR task_type != p_exclude_task_type)
    ORDER BY created_at ASC
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
