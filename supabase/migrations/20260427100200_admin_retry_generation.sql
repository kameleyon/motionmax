-- Migration: admin_retry_generation
--
-- Powers the Wave 2 "Retry generation" button on AdminGenerations.
-- Lets an admin re-queue a failed video_generation_jobs row with the
-- same payload, marking the original as 'archived' so it disappears
-- from the active queue / dedup partial unique indexes.
--
-- Pattern mirrors admin_cancel_job_with_refund (same admin gate, same
-- admin_logs schema, same REVOKE/GRANT). All three operations
-- (insert new row, archive original, write audit row) happen inside
-- a single SECURITY DEFINER transaction so the admin's session never
-- writes the privileged columns directly.
--
-- Schema notes (all confirmed by reading prior migrations):
--   • Generation table is `public.video_generation_jobs` -- this is
--     what AdminGenerations.tsx + admin-stats edge function read,
--     and what admin_cancel_job_with_refund operates on. The other
--     `generations` table is a different (per-script) entity.
--   • Status enum (chk_video_generation_jobs_status, migration
--     20260419190001) only allows {'pending','processing','completed',
--     'failed'}. There is NO 'error' / 'cancelled' / 'queued' /
--     'archived' value. So:
--       - The only terminal-failed status to allow retry from is 'failed'.
--       - To mark the original 'archived' we must extend the CHECK
--         constraint here.
--       - The new row uses 'pending' (the codebase's queued state),
--         not 'queued'.
--   • Columns on the table: id, project_id, user_id, task_type,
--     status, payload, progress, error_message, created_at,
--     updated_at, result, depends_on, worker_id. There is NO
--     `attempts` column (so nothing to reset to 0), NO `error`
--     column (it's `error_message`), NO `archived_at`, NO
--     `retried_from`. We add the last two below.
--   • Partial unique indexes uq_video_jobs_project_task_active and
--     uq_video_jobs_project_task_scene_active both filter on
--     status IN ('pending','processing'). Archiving the original
--     drops it from the index; the new 'pending' row enters cleanly
--     UNLESS another active job for the same project_id+task_type
--     (or scene) is already in flight, in which case the insert
--     correctly fails with unique_violation -- that's the dedup
--     contract, not a bug.

-- ── 1. Extend status CHECK to allow 'archived' ───────────────────
ALTER TABLE public.video_generation_jobs
  DROP CONSTRAINT IF EXISTS chk_video_generation_jobs_status;

ALTER TABLE public.video_generation_jobs
  ADD  CONSTRAINT chk_video_generation_jobs_status
       CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'archived'));

-- ── 2. Add archived_at + retried_from columns ────────────────────
ALTER TABLE public.video_generation_jobs
  ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retried_from UUID
    REFERENCES public.video_generation_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_video_jobs_retried_from
  ON public.video_generation_jobs (retried_from)
  WHERE retried_from IS NOT NULL;

-- ── 3. RPC ───────────────────────────────────────────────────────
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

  -- Only retry from a terminal failed state. The CHECK constraint
  -- guarantees status is one of {pending,processing,completed,failed,
  -- archived}; 'failed' is the only failed-terminal value in this
  -- codebase (no 'error'/'cancelled' enum members exist).
  IF v_orig.status <> 'failed' THEN
    RAISE EXCEPTION 'admin_retry_generation: can only retry status=failed jobs (got %)', v_orig.status
      USING ERRCODE = '22023';
  END IF;

  -- Insert NEW row by explicitly listing every non-id, non-status,
  -- non-timestamp, non-error, non-progress, non-worker column from
  -- the original. progress=0, error_message=NULL, worker_id=NULL,
  -- result=NULL on the new row -- a fresh job, not a clone of the
  -- failed run's intermediate state.
  INSERT INTO public.video_generation_jobs (
    project_id,
    user_id,
    task_type,
    payload,
    depends_on,
    status,
    progress,
    error_message,
    result,
    worker_id,
    retried_from,
    created_at,
    updated_at
  )
  SELECT
    o.project_id,
    o.user_id,
    o.task_type,
    o.payload,
    o.depends_on,
    'pending'::TEXT,   -- codebase's queued state
    0,
    NULL,
    NULL,
    NULL,
    o.id,              -- link back to the original
    NOW(),
    NOW()
  FROM public.video_generation_jobs o
  WHERE o.id = generation_id
  RETURNING id INTO v_new_id;

  -- Archive the original. status='archived' drops the row out of
  -- both partial unique indexes (which filter on
  -- status IN ('pending','processing')) so it can't conflict with
  -- the freshly inserted retry.
  UPDATE public.video_generation_jobs
  SET status      = 'archived',
      archived_at = NOW(),
      updated_at  = NOW()
  WHERE id = generation_id;

  -- Audit row. admin_logs schema is (admin_id, action, target_type,
  -- target_id, details) -- same as admin_cancel_job_with_refund.
  INSERT INTO public.admin_logs (
    admin_id,
    action,
    target_type,
    target_id,
    details
  ) VALUES (
    v_admin_id,
    'retry_generation',
    'video_generation_job',
    generation_id,
    jsonb_build_object(
      'new_id',          v_new_id,
      'user_id',         v_orig.user_id,
      'project_id',      v_orig.project_id,
      'task_type',       v_orig.task_type,
      'previous_status', v_orig.status,
      'previous_error',  v_orig.error_message
    )
  );

  RETURN v_new_id;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_retry_generation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_retry_generation(UUID) TO authenticated;

COMMENT ON FUNCTION public.admin_retry_generation(UUID) IS
  'Admin-only: re-queues a failed video_generation_jobs row by inserting a fresh pending copy (with retried_from link) and marking the original status=archived (archived_at=NOW()). Verifies is_admin(auth.uid()). Writes an admin_logs entry. Returns the new generation id. Will fail with unique_violation if another active job already exists for the same (project_id, task_type[, sceneIndex]) -- intentional dedup.';
