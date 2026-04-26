-- Migration: admin_cancel_job_with_refund
--
-- Problem: AdminQueueMonitor cancel button used to call
-- supabase.rpc('increment_user_credits') from an admin's authenticated
-- session. That function was REVOKED from the `authenticated` role per
-- migration 20260320210000 (only service_role can run it), so the refund
-- silently 403'd while the job-cancel half of the operation succeeded.
-- Result: credits were destroyed.
--
-- Fix: a single SECURITY DEFINER RPC, gated on is_admin(auth.uid()),
-- that performs all three steps atomically:
--   1. Cancel the job (status='failed', stamp error_message)
--   2. Increment the job owner's credits via the privileged path
--   3. Insert an admin_logs row for audit trail
--
-- Until the broader admin-action edge function lands (roadmap Task #10),
-- this gives Phase 0 a working cancel-with-refund without exposing
-- increment_user_credits to authenticated.

CREATE OR REPLACE FUNCTION public.admin_cancel_job_with_refund(
  p_job_id      UUID,
  p_refund_credits INT DEFAULT 1,
  p_reason      TEXT DEFAULT 'Cancelled by admin'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_job RECORD;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_cancel_job_with_refund: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_cancel_job_with_refund: forbidden'
      USING ERRCODE = '42501';
  END IF;

  IF p_refund_credits IS NULL OR p_refund_credits < 0 THEN
    RAISE EXCEPTION 'admin_cancel_job_with_refund: refund must be >= 0'
      USING ERRCODE = '22023';
  END IF;

  -- Look up the job + lock it for update so two admins racing on the
  -- same job don't double-refund.
  SELECT id, user_id, status
  INTO v_job
  FROM public.video_generation_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'admin_cancel_job_with_refund: job % not found', p_job_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Already-terminal jobs cannot be cancelled / refunded again.
  IF v_job.status IN ('completed', 'failed') THEN
    RETURN jsonb_build_object(
      'cancelled',  FALSE,
      'refunded',   0,
      'reason',     'job already terminal',
      'jobStatus',  v_job.status
    );
  END IF;

  UPDATE public.video_generation_jobs
  SET status = 'failed',
      error_message = p_reason,
      updated_at = NOW()
  WHERE id = p_job_id;

  -- Refund via the existing internal helper. We keep the privileged path
  -- here (SECURITY DEFINER) so the admin's session never touches it.
  IF p_refund_credits > 0 THEN
    PERFORM public.increment_user_credits(
      p_user_id => v_job.user_id,
      p_credits => p_refund_credits
    );
  END IF;

  INSERT INTO public.admin_logs (
    admin_id,
    action,
    target_type,
    target_id,
    details
  ) VALUES (
    v_admin_id,
    'cancel_job_with_refund',
    'video_generation_job',
    p_job_id,
    jsonb_build_object(
      'user_id',           v_job.user_id,
      'previous_status',   v_job.status,
      'refunded_credits',  p_refund_credits,
      'reason',            p_reason
    )
  );

  RETURN jsonb_build_object(
    'cancelled',         TRUE,
    'refunded',          p_refund_credits,
    'jobId',             p_job_id,
    'previousStatus',    v_job.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_cancel_job_with_refund(UUID, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_cancel_job_with_refund(UUID, INT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.admin_cancel_job_with_refund(UUID, INT, TEXT)
IS 'Admin-only: atomically cancels a video_generation_jobs row, refunds credits to the job owner via the privileged increment_user_credits path, and writes an admin_logs entry. Verifies is_admin(auth.uid()) at entry. Idempotent on already-terminal jobs.';
