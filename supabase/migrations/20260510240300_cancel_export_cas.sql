-- ============================================================
-- C-7-15 / Ghost G-C6: atomic cancel-export CAS RPC
-- ============================================================
--
-- WHY:
--   The user-initiated cancel path in BulkOpModal.cancelExport
--   issued a plain UPDATE against video_generation_jobs filtered by
--   `.in('status', ['pending', 'processing'])`. That filter LOOKS
--   safe but the result returned no information about whether any
--   rows were actually changed — the cancel toast always fired even
--   if the worker had ALREADY written status='completed' a few
--   milliseconds earlier (the worker is on a separate process, so
--   the cancel can lose the race). User then saw BOTH "Cancelled"
--   AND "Export ready" toasts and didn't know if their video
--   rendered or not. Credit-refund logic also can't tell which
--   path won.
--
--   This RPC does a true CAS (compare-and-swap): UPDATE …
--   WHERE status IN ('pending','processing') RETURNING id. If 0 ids
--   are returned, the worker already finished and the caller should
--   NOT show "Cancelled" — it should show "Export ready". The
--   client uses the returned count to decide which toast to fire.

CREATE OR REPLACE FUNCTION public.cancel_export_jobs_cas(
  p_project_id UUID
) RETURNS TABLE (
  cancelled_count INTEGER,
  already_completed_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_cancelled INTEGER := 0;
  v_already_done INTEGER := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  -- CAS update: only flip rows that are still in flight. The
  -- RETURNING clause hands back the rows we actually changed so the
  -- caller can count cancellations vs. losses.
  WITH cas_update AS (
    UPDATE public.video_generation_jobs
       SET status = 'failed',
           error_message = 'Cancelled by user',
           updated_at = NOW()
     WHERE project_id = p_project_id
       AND user_id = v_user_id
       AND task_type = 'export_video'
       AND status IN ('pending', 'processing')
    RETURNING id
  )
  SELECT COUNT(*)::INTEGER INTO v_cancelled FROM cas_update;

  -- Count of in-flight jobs that ALREADY transitioned to completed
  -- in the window between the user's cancel click and this RPC
  -- firing. If > 0, the frontend should treat the cancel as lost
  -- (worker won the race) and show the "Export ready" path.
  SELECT COUNT(*)::INTEGER INTO v_already_done
    FROM public.video_generation_jobs
   WHERE project_id = p_project_id
     AND user_id = v_user_id
     AND task_type = 'export_video'
     AND status = 'completed'
     -- Only consider rows the user could plausibly have been trying
     -- to cancel (last 5 minutes — anything older is a stale tab).
     AND updated_at > NOW() - INTERVAL '5 minutes';

  RETURN QUERY SELECT v_cancelled, v_already_done;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_export_jobs_cas(UUID) TO authenticated;
COMMENT ON FUNCTION public.cancel_export_jobs_cas IS
  'C-7-15: CAS-based cancel for export jobs. Returns (cancelled_count, already_completed_count) so the caller can fire the correct toast without racing the worker.';
