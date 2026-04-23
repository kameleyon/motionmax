-- Let finalize (and any dependent job) proceed even when some upstream
-- deps have FAILED.
--
-- Previous behaviour (20260419380000): `claim_pending_job` only claimed
-- a job when every entry in `depends_on` was status='completed'. If any
-- dep was in status='failed', the NOT EXISTS check stayed true forever,
-- leaving the dependent pending indefinitely. Real impact: a single
-- scene's Gemini TTS exhaustion (5 retries returning empty) would block
-- `finalize_generation` forever, even though the other 14/15 scenes
-- finished successfully. Music (Lyria 3 Pro) never runs, generation
-- stays status='processing', worker goes idle — the entire pipeline
-- freezes on one bad scene.
--
-- New behaviour: treat deps as "done waiting" when they reach any
-- TERMINAL status — `completed` OR `failed`. The dependent handler
-- (handleFinalize, exportVideo) already has per-scene null-URL guards
-- so it tolerates missing data from failed scenes gracefully. Better to
-- produce a partial result with 14/15 scenes than to leave the whole
-- generation stuck forever.

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
