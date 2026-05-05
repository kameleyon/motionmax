-- Migration: admin_cancel_all_active_jobs
--
-- Bulk hard-cancel for the admin panel. Cancels:
--   1. ALL pending jobs across all users (worker hasn't picked them up yet)
--   2. ALL processing jobs (currently in flight + zombies)
--
-- Each cancellation:
--   - flips status to 'failed' with a marker error_message
--   - refunds 1 credit to the job owner via the privileged
--     increment_user_credits path
--   - writes one admin_logs row per cancelled job for audit trail
--
-- Returns counts so the UI can confirm to the admin.
--
-- Why this matters: the worker's job-claim filter is
--   status IN ('pending', 'processing')
-- so the moment a job's status flips to 'failed', no new picker can
-- claim it. In-flight workers will still finish their current step
-- (we don't kill HTTP/ffmpeg mid-call), but downstream consumers see
-- the row as 'failed' and discard the result. This is sufficient for
-- the "stop everything now" admin panic button.

CREATE OR REPLACE FUNCTION public.admin_cancel_all_active_jobs(
  p_kill_processing BOOLEAN DEFAULT TRUE,
  p_refund_credits  INT     DEFAULT 1,
  p_reason          TEXT    DEFAULT 'Bulk cancelled by admin'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id          UUID := auth.uid();
  v_pending_count     INT  := 0;
  v_processing_count  INT  := 0;
  v_total_refunded    INT  := 0;
  v_job               RECORD;
  v_target_statuses   TEXT[];
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_cancel_all_active_jobs: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_cancel_all_active_jobs: forbidden'
      USING ERRCODE = '42501';
  END IF;

  IF p_refund_credits IS NULL OR p_refund_credits < 0 THEN
    RAISE EXCEPTION 'admin_cancel_all_active_jobs: refund must be >= 0'
      USING ERRCODE = '22023';
  END IF;

  v_target_statuses := CASE
    WHEN p_kill_processing THEN ARRAY['pending', 'processing']
    ELSE ARRAY['pending']
  END;

  -- Loop with FOR UPDATE SKIP LOCKED so two admins racing on this RPC
  -- don't double-cancel the same row. Each cancellation is independent
  -- in terms of credit refund + admin_logs, so we don't wrap the loop
  -- in an explicit transaction beyond the implicit function txn.
  FOR v_job IN
    SELECT id, user_id, status
    FROM public.video_generation_jobs
    WHERE status = ANY (v_target_statuses)
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.video_generation_jobs
    SET status = 'failed',
        error_message = p_reason,
        updated_at = NOW()
    WHERE id = v_job.id;

    IF p_refund_credits > 0 THEN
      PERFORM public.increment_user_credits(
        p_user_id => v_job.user_id,
        p_credits => p_refund_credits
      );
      v_total_refunded := v_total_refunded + p_refund_credits;
    END IF;

    INSERT INTO public.admin_logs (
      admin_id,
      action,
      target_type,
      target_id,
      details
    ) VALUES (
      v_admin_id,
      'bulk_cancel_active_jobs',
      'video_generation_job',
      v_job.id,
      jsonb_build_object(
        'user_id',          v_job.user_id,
        'previous_status',  v_job.status,
        'refunded_credits', p_refund_credits,
        'reason',           p_reason
      )
    );

    IF v_job.status = 'pending' THEN
      v_pending_count := v_pending_count + 1;
    ELSE
      v_processing_count := v_processing_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'pending_cancelled',    v_pending_count,
    'processing_cancelled', v_processing_count,
    'total_cancelled',      v_pending_count + v_processing_count,
    'total_refunded',       v_total_refunded
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_cancel_all_active_jobs(BOOLEAN, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_cancel_all_active_jobs(BOOLEAN, INT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.admin_cancel_all_active_jobs(BOOLEAN, INT, TEXT)
IS 'Admin-only bulk hard-cancel: flips every pending (and optionally processing) video_generation_jobs row to failed, refunds credits via the privileged path, writes one admin_logs row per cancellation. Verifies is_admin(auth.uid()) at entry. Idempotent.';
