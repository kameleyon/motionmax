-- ============================================================
-- admin_retry_generation: also un-fail the autopost_runs row when
-- the retried job is an autopost orchestrator.
-- ============================================================
-- Background:
-- The original RPC (20260427100200_admin_retry_generation.sql) clones
-- a failed video_generation_jobs row into a fresh 'pending' row with
-- the same payload (including payload->>'autopost_run_id') and
-- archives the original. It does NOT touch autopost_runs.
--
-- The autopost_render handler (worker/src/handlers/autopost/
-- handleAutopostRun.ts) has a defensive gate that refuses to re-run
-- when autopost_runs.status IN ('failed','cancelled'). So every
-- admin retry on an autopost orchestrator was claimed by a worker,
-- read the still-failed run row, and immediately threw
-- "autopost_render: run <uuid> already in terminal status=failed;
-- refusing to re-run" — making the Retry button a silent no-op
-- visible only in worker logs.
--
-- Fix: when the cloned row's task_type is one of the autopost
-- orchestrators, also flip the linked autopost_runs row back to a
-- claimable state (status='queued', error_summary=NULL,
-- progress_pct=NULL, video_job_id=<new job id>). The handler's
-- progress_pct=0 + queued/generating status combination is exactly
-- what autopost_tick produces for a fresh run, so the retry walks
-- the same code path as a brand-new fire.
--
-- All other task types behave exactly as before — this is a no-op
-- when payload->>'autopost_run_id' is null.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_retry_generation(
  generation_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_orig     RECORD;
  v_new_id   UUID;
  v_run_id   UUID;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_retry_generation: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_retry_generation: forbidden'
      USING ERRCODE = '42501';
  END IF;

  -- Lock the original row so two admins racing on the same generation
  -- don't both produce duplicate retries.
  SELECT *
  INTO v_orig
  FROM public.video_generation_jobs
  WHERE id = generation_id
  FOR UPDATE;

  IF v_orig IS NULL THEN
    RAISE EXCEPTION 'admin_retry_generation: generation % not found', generation_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_orig.status <> 'failed' THEN
    RAISE EXCEPTION 'admin_retry_generation: can only retry status=failed jobs (got %)', v_orig.status
      USING ERRCODE = '22023';
  END IF;

  -- Insert NEW row. Identical to prior behavior.
  INSERT INTO public.video_generation_jobs (
    project_id, user_id, task_type, payload, depends_on,
    status, progress, error_message, result, worker_id,
    retried_from, created_at, updated_at
  )
  SELECT
    o.project_id, o.user_id, o.task_type, o.payload, o.depends_on,
    'pending'::TEXT, 0, NULL, NULL, NULL,
    o.id, NOW(), NOW()
  FROM public.video_generation_jobs o
  WHERE o.id = generation_id
  RETURNING id INTO v_new_id;

  -- Archive the original.
  UPDATE public.video_generation_jobs
  SET status      = 'archived',
      archived_at = NOW(),
      updated_at  = NOW()
  WHERE id = generation_id;

  -- NEW: when retrying an autopost orchestrator, also un-fail the
  -- linked autopost_runs row and point video_job_id at the new job.
  -- Without this, the handler's status='failed' gate trips on the
  -- first claim of the cloned row.
  IF v_orig.task_type IN ('autopost_render', 'autopost_rerender')
     AND v_orig.payload ? 'autopost_run_id' THEN
    v_run_id := (v_orig.payload ->> 'autopost_run_id')::uuid;

    UPDATE public.autopost_runs
       SET status        = 'queued',
           video_job_id  = v_new_id,
           error_summary = NULL,
           progress_pct  = NULL
     WHERE id = v_run_id
       AND status IN ('failed', 'cancelled');
  END IF;

  -- Audit row.
  INSERT INTO public.admin_logs (
    admin_id, action, target_type, target_id, details
  ) VALUES (
    v_admin_id, 'retry_generation', 'video_generation_job', generation_id,
    jsonb_build_object(
      'new_id',          v_new_id,
      'user_id',         v_orig.user_id,
      'project_id',      v_orig.project_id,
      'task_type',       v_orig.task_type,
      'previous_status', v_orig.status,
      'previous_error',  v_orig.error_message,
      'autopost_run_reset', v_run_id IS NOT NULL
    )
  );

  RETURN v_new_id;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_retry_generation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_retry_generation(UUID) TO authenticated;

COMMENT ON FUNCTION public.admin_retry_generation(UUID) IS
  'Admin-only: re-queues a failed video_generation_jobs row by inserting a fresh pending copy (with retried_from link) and marking the original archived. For autopost_render/autopost_rerender source rows, ALSO resets the linked autopost_runs row back to queued and re-points video_job_id at the new job — the handler''s defensive status gate would otherwise refuse to claim the new row. Verifies is_admin(auth.uid()). Writes an admin_logs entry. Returns the new generation id.';

COMMIT;
