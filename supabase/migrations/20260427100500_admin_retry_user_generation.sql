-- Migration: admin_retry_user_generation
--
-- Powers the AdminGenerations "Retry generation" button at the
-- USER-FACING `public.generations` level (the per-script entity that
-- AdminGenerations.tsx + fetchGenerationList in adminDirectQueries.ts
-- read from). This is the companion to admin_retry_generation
-- (migration 20260427100200) which targets the worker-job entity
-- `public.video_generation_jobs` and is consumed by AdminQueueMonitor.
--
-- Both RPCs co-exist deliberately: same shape, different tables.
--
-- Schema notes (all confirmed by reading prior migrations):
--   • Original generations schema (20260111215156): id, project_id,
--     user_id, status, progress, script, scenes, audio_url, video_url,
--     error_message, started_at, completed_at, created_at.
--   • updated_at added in 20260419160000 with auto-update trigger.
--   • Status CHECK (chk_generations_status, migration 20260419190001)
--     allows ONLY {'pending','processing','complete','error'}. The
--     failed-state in this table is 'error' (NOT 'failed' — the
--     'failed' label belongs to video_generation_jobs). This matches
--     fetchGenerationStats in adminDirectQueries.ts which buckets by
--     {pending, processing, complete, error, deleted}.
--   • To mark the original 'archived' we MUST extend the CHECK
--     constraint here — 'archived' is not currently allowed.
--   • Columns archived_at and retried_from do not exist; both added
--     idempotently below.

-- ── 1. Extend status CHECK to allow 'archived' ───────────────────
ALTER TABLE public.generations
  DROP CONSTRAINT IF EXISTS chk_generations_status;

ALTER TABLE public.generations
  ADD  CONSTRAINT chk_generations_status
       CHECK (status IN ('pending', 'processing', 'complete', 'error', 'archived'));

-- ── 2. Add archived_at + retried_from columns ────────────────────
ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retried_from UUID
    REFERENCES public.generations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_generations_retried_from
  ON public.generations (retried_from)
  WHERE retried_from IS NOT NULL;

-- ── 3. RPC ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_retry_user_generation(
  generation_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_orig     RECORD;
  v_new_id   UUID;
BEGIN
  -- Two-stage admin gate, identical SQLSTATEs to the sibling RPCs.
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_retry_user_generation: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_retry_user_generation: forbidden'
      USING ERRCODE = '42501';
  END IF;

  -- Lock the original row so two admins racing on the same generation
  -- don't both produce duplicate retries.
  SELECT *
  INTO v_orig
  FROM public.generations
  WHERE id = generation_id
  FOR UPDATE;

  IF v_orig IS NULL THEN
    RAISE EXCEPTION 'admin_retry_user_generation: generation % not found', generation_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Only retry from the terminal failed state. The CHECK constraint
  -- guarantees status is one of {pending,processing,complete,error,
  -- archived}; 'error' is the failed-terminal value in the
  -- generations table (per chk_generations_status and the
  -- fetchGenerationStats bucket map).
  IF v_orig.status <> 'error' THEN
    RAISE EXCEPTION 'admin_retry_user_generation: can only retry status=error generations (got %)', v_orig.status
      USING ERRCODE = '22023';
  END IF;

  -- Insert NEW row copying input fields (project_id, user_id, script,
  -- scenes) and resetting all execution-state fields. status='pending',
  -- progress=0, audio_url/video_url/error_message NULL, timestamps
  -- cleared, created_at=now().
  INSERT INTO public.generations (
    project_id,
    user_id,
    script,
    scenes,
    status,
    progress,
    audio_url,
    video_url,
    error_message,
    started_at,
    completed_at,
    retried_from,
    created_at
  )
  SELECT
    o.project_id,
    o.user_id,
    o.script,
    o.scenes,
    'pending'::TEXT,
    0,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    o.id,        -- link back to the original
    NOW()
  FROM public.generations o
  WHERE o.id = generation_id
  RETURNING id INTO v_new_id;

  -- Archive the original. status='archived' is now permitted by the
  -- extended CHECK above; the update_generations_updated_at trigger
  -- (migration 20260419160000) refreshes updated_at automatically.
  UPDATE public.generations
  SET status      = 'archived',
      archived_at = NOW()
  WHERE id = generation_id;

  -- Audit row. admin_logs schema (admin_id, action, target_type,
  -- target_id, details) matches admin_cancel_job_with_refund and
  -- admin_retry_generation.
  INSERT INTO public.admin_logs (
    admin_id,
    action,
    target_type,
    target_id,
    details
  ) VALUES (
    v_admin_id,
    'retry_user_generation',
    'generation',
    generation_id,
    jsonb_build_object(
      'new_id',          v_new_id,
      'project_id',      v_orig.project_id,
      'original_status', v_orig.status
    )
  );

  RETURN v_new_id;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_retry_user_generation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_retry_user_generation(UUID) TO authenticated;

COMMENT ON FUNCTION public.admin_retry_user_generation(UUID) IS
  'Admin-only: re-runs a failed public.generations row by inserting a fresh pending copy (project_id/user_id/script/scenes preserved, all execution state reset, retried_from linked) and marking the original status=archived (archived_at=NOW()). Verifies is_admin(auth.uid()). Writes one admin_logs entry (action=retry_user_generation, target_type=generation). Returns the new generation id. Companion to admin_retry_generation, which operates on the worker-job entity public.video_generation_jobs.';
