-- ============================================================
-- autopost_fresh_render — user-driven regen for a failed/cancelled
-- autopost run, atomic over the three writes that previously failed
-- silently behind RLS (no UPDATE policy on autopost_runs for end users).
-- ============================================================
-- Background:
-- The autopost_runs table only grants SELECT / INSERT / DELETE to the
-- `authenticated` role (see 20260502160000_autopost_drop_admin_gate.sql).
-- UPDATE was deliberately omitted — writes were originally the worker's
-- (service_role) job: markRunFailed, the reapers, autopost_tick. The
-- frontend Regen button (RunHistory.tsx performRegenerate) is the first
-- user-driven flow that needs to UPDATE autopost_runs (reset status to
-- 'queued' so handleAutopostRun's defensive gate will re-claim it).
--
-- Without an UPDATE policy, supabase-js returns { error: null, count:
-- null } for a blocked UPDATE — looks identical to "WHERE matched zero
-- rows." The frontend couldn't tell the reset was denied; the new
-- orchestrator job got inserted, claimed by the worker, and hit the
-- status-gate at handleAutopostRun.ts:556 — exactly the loop the user
-- reported with run ea245bef-49d6-4d0d-91de-5f1e0728d986.
--
-- This RPC is the structural fix:
--   1. Single transaction over reset + insert + attach.
--   2. Ownership check (caller must own the schedule).
--   3. State guard (only failed/cancelled runs can be regenerated;
--      can't be used to revive a completed run or hijack one).
--   4. SECURITY DEFINER bypasses the missing autopost_runs UPDATE
--      policy without granting blanket UPDATE rights.
--
-- The autopost_rerender path (existing-generation case) doesn't go
-- through this RPC — it only INSERTs into video_generation_jobs,
-- which already works under the existing user-level INSERT policy.
-- Only the fresh-render path needs the atomic reset.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.autopost_fresh_render(
  p_run_id  UUID,
  p_payload JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_owner      UUID;
  v_run_status TEXT;
  v_new_job_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'autopost_fresh_render: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  -- Lock the run row + verify ownership in one shot. FOR UPDATE OF ar
  -- prevents two concurrent regen calls from both inserting jobs.
  SELECT s.user_id, ar.status
    INTO v_owner, v_run_status
    FROM public.autopost_runs ar
    JOIN public.autopost_schedules s ON s.id = ar.schedule_id
   WHERE ar.id = p_run_id
   FOR UPDATE OF ar;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'autopost_fresh_render: run % not found', p_run_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_owner <> v_user_id THEN
    RAISE EXCEPTION 'autopost_fresh_render: forbidden'
      USING ERRCODE = '42501';
  END IF;

  -- Only allow regen from a terminal-failed state. Refusing to act on
  -- 'queued' / 'generating' / 'rendered' / 'publishing' / 'completed'
  -- prevents accidental double-fires from a rapid double-click on
  -- a completed-but-still-rendering-thumbnail run.
  IF v_run_status NOT IN ('failed', 'cancelled') THEN
    RAISE EXCEPTION 'autopost_fresh_render: run is %; can only regen from failed/cancelled', v_run_status
      USING ERRCODE = '22023';
  END IF;

  -- Reset the run so handleAutopostRun's status-gate accepts a fresh
  -- claim (it refuses status IN ('failed','cancelled') without a
  -- _transientRetryAttempt marker, which a user-driven regen lacks).
  UPDATE public.autopost_runs
     SET status        = 'queued',
         progress_pct  = NULL,
         error_summary = NULL,
         video_job_id  = NULL
   WHERE id = p_run_id;

  -- Insert the new orchestrator. project_id stays NULL — same shape
  -- as autopost_tick's INSERT — handleAutopostRun creates the project
  -- mid-flight from p_payload (which carries the topic prompt + cfg).
  INSERT INTO public.video_generation_jobs (
    user_id, task_type, status, payload
  ) VALUES (
    v_user_id, 'autopost_render', 'pending', p_payload
  )
  RETURNING id INTO v_new_job_id;

  -- Wire the new job back onto the run so the dashboard's progress
  -- subscription tracks the correct job.
  UPDATE public.autopost_runs
     SET video_job_id = v_new_job_id
   WHERE id = p_run_id;

  RETURN v_new_job_id;
END;
$$;

REVOKE ALL    ON FUNCTION public.autopost_fresh_render(UUID, JSONB) FROM PUBLIC;
REVOKE ALL    ON FUNCTION public.autopost_fresh_render(UUID, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.autopost_fresh_render(UUID, JSONB) TO authenticated;

COMMENT ON FUNCTION public.autopost_fresh_render(UUID, JSONB) IS
  'User-driven autopost regen for failed/cancelled runs. Atomic over: reset autopost_runs to queued, insert new autopost_render orchestrator, attach new video_job_id. Caller must own the schedule. Returns the new job id. Used by RunHistory.tsx performRegenerate for the fresh-render path (the autopost_rerender path INSERTs directly into video_generation_jobs and does not need this RPC).';

COMMIT;
