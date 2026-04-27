-- Migration: admin_resolve_all_flags
--
-- Problem: AdminFlags' "unblock all flags" admin action used to issue N
-- separate resolve_flag calls in a serial loop from the browser. That
-- pattern is slow (N round trips), unbounded under heavy fan-out, and
-- partial-failure-prone -- if call k of N rejects, the user is left in
-- a half-resolved state with no atomicity guarantee and the audit trail
-- shows k disconnected resolve_flag entries instead of one bulk action.
--
-- Fix: a single SECURITY DEFINER RPC, gated on is_admin(auth.uid()),
-- that performs the bulk resolve atomically:
--   1. UPDATE every active (resolved_at IS NULL) user_flags row for the
--      target user in ONE statement, capturing the affected row count
--      via GET DIAGNOSTICS.
--   2. Insert ONE admin_logs row recording the bulk action with the
--      count and notes in details.
--   3. Return the count to the caller.
--
-- Authorization mirrors admin_cancel_job_with_refund exactly: gate on
-- is_admin(auth.uid()) with the same SQLSTATE 42501 raises. Per-flag
-- column update semantics (resolved_at, resolved_by, resolution_notes)
-- match the existing resolve_flag path in supabase/functions/admin-stats
-- (case "resolve_flag"). admin_logs columns match the original schema
-- in 20260201152356 (admin_id, action, target_type, target_id, details),
-- which is the same schema admin_cancel_job_with_refund writes against.

CREATE OR REPLACE FUNCTION public.admin_resolve_all_flags(
  target_user_id    UUID,
  resolution_notes  TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_notes    TEXT := COALESCE(resolution_notes, 'Bulk resolved');
  v_count    INT;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_resolve_all_flags: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_resolve_all_flags: forbidden'
      USING ERRCODE = '42501';
  END IF;

  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'admin_resolve_all_flags: target_user_id is required'
      USING ERRCODE = '22023';
  END IF;

  -- Single-statement bulk resolve. Column semantics match the per-flag
  -- resolve_flag path: resolved_at = now(), resolved_by = the acting
  -- admin, resolution_notes = caller-supplied or 'Bulk resolved'. The
  -- WHERE clause guards against re-resolving already-resolved rows so
  -- the count we return reflects only newly-resolved flags and the
  -- audit log is accurate.
  UPDATE public.user_flags
     SET resolved_at      = NOW(),
         resolved_by      = v_admin_id,
         resolution_notes = v_notes,
         updated_at       = NOW()
   WHERE user_id     = target_user_id
     AND resolved_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- One audit row for the whole bulk action, regardless of how many
  -- flags were touched (including zero -- the attempt itself is
  -- auditable). Schema matches admin_cancel_job_with_refund.
  INSERT INTO public.admin_logs (
    admin_id,
    action,
    target_type,
    target_id,
    details
  ) VALUES (
    v_admin_id,
    'resolve_all_flags',
    'user',
    target_user_id,
    jsonb_build_object(
      'count',           v_count,
      'notes',           v_notes,
      'target_user_id',  target_user_id,
      'performed_by',    v_admin_id
    )
  );

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_all_flags(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_resolve_all_flags(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.admin_resolve_all_flags(UUID, TEXT)
IS 'Admin-only: atomically resolves every active (resolved_at IS NULL) user_flags row for target_user_id in a single UPDATE, writes one admin_logs row, and returns the number of flags resolved. Replaces the serial per-flag resolve loop in AdminFlags. Verifies is_admin(auth.uid()) at entry. Idempotent on users with no active flags (returns 0).';
