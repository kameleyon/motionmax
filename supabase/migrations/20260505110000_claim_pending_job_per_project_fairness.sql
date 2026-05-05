-- Cross-project fairness in claim_pending_job.
--
-- Previous behaviour (20260423210000_claim_pending_job_partial_failure):
--   ORDER BY active_count ASC, j.created_at ASC
-- where active_count was the count of the *user's* in-flight jobs.
--
-- Real-world failure: one user kicks off two generations back-to-back.
-- Project A (cinematic) enqueues 32 jobs (master_audio + 15 image + 15
-- video + finalize). Project B (explainer) enqueues 17 jobs a minute
-- later. Both belong to the same user, so active_count is identical
-- for every job in both sets — sort collapses to pure FIFO by
-- created_at. Project A's 30 cinematic_video jobs always beat Project
-- B's 15 cinematic_image jobs to any free LLM slot, even though
-- Project B is still on its first wave of work. The user perceives
-- Project B as "stuck waiting on Project A's videos" — exactly the
-- symptom this migration addresses.
--
-- New ordering:
--   ORDER BY user_active_count    ASC,    -- inter-user fairness (kept)
--            project_active_count ASC,    -- intra-user inter-project fairness (NEW)
--            j.created_at         ASC     -- FIFO tiebreaker (kept)
--
-- Effect: when User X has Project A burning 6 slots and submits Project
-- B, the next claim picks a Project B job (project_active_count = 0)
-- ahead of any Project A job (project_active_count = 6) regardless of
-- how much older Project A's jobs are. Once both projects have equal
-- in-flight work, FIFO breaks the tie. Jobs without project_id (legacy
-- or system-level tasks) get treated as project_active_count = 0 and
-- continue to run FIFO among themselves.

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
      ) AS user_active_count,
      (
        SELECT COUNT(*)
        FROM public.video_generation_jobs a
        WHERE a.project_id IS NOT NULL
          AND a.project_id = j.project_id
          AND a.status = 'processing'
      ) AS project_active_count
    FROM public.video_generation_jobs j
    WHERE j.status = 'pending'
      AND (p_task_type IS NULL OR j.task_type = p_task_type)
      AND (p_exclude_task_type IS NULL OR j.task_type != p_exclude_task_type)
      -- Dependency gate: claim when every dep is in a terminal state
      -- (completed OR failed). Failed deps release dependents so
      -- finalize can produce a partial result instead of hanging.
      AND (
        j.depends_on = '{}'
        OR NOT EXISTS (
          SELECT 1 FROM public.video_generation_jobs dep
          WHERE dep.id = ANY(j.depends_on)
            AND dep.status NOT IN ('completed', 'failed')
        )
      )
    ORDER BY
      user_active_count    ASC,
      project_active_count ASC,
      j.created_at         ASC
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
