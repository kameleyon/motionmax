-- Migration: profiles.deleted_at + admin_soft_delete_user
--
-- Adds the soft-delete column on profiles plus a SECURITY DEFINER RPC the
-- admin UI calls to mark a profile deleted and scrub PII (display_name,
-- avatar_url) atomically. Companion to the admin-hard-delete-user edge
-- function which performs the irreversible auth.admin.deleteUser path.
--
-- Soft-delete semantics:
--   - profiles.deleted_at = NOW()              (filter active users via WHERE deleted_at IS NULL)
--   - profiles.display_name = NULL             (PII scrub)
--   - profiles.avatar_url   = NULL             (PII scrub)
--   - auth.users row is left alone — the user can still authenticate at
--     the GoTrue level; if you want them locked out, use admin-force-signout
--     in addition. This RPC is intentionally narrow: profile-only.
--
-- Authorization mirrors admin_resolve_all_flags exactly: two-stage gate
-- on auth.uid() then is_admin(auth.uid()), both raising SQLSTATE 42501.
-- Self-target guard prevents an admin from accidentally tombstoning their
-- own profile (which would also clear their display_name/avatar everywhere).
--
-- admin_logs schema matches the original 20260201152356 schema and the
-- pattern used by admin_resolve_all_flags / admin_cancel_job_with_refund:
-- (admin_id, action, target_type, target_id, details).

-- ── 1. Column: profiles.deleted_at ────────────────────────────────────
-- Idempotent so re-running this migration on an environment where it
-- partially applied is safe.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.deleted_at
  IS 'Soft-delete tombstone. When non-null, the profile is considered deleted by an admin; PII (display_name, avatar_url) is scrubbed at the same time. NULL = active. Set via public.admin_soft_delete_user(uuid). Filter active users with WHERE deleted_at IS NULL.';

-- ── 2. Sparse index for active-user filtering ─────────────────────────
-- Most queries want active profiles (deleted_at IS NULL), and the
-- expected ratio of soft-deleted rows is small. A partial index on
-- non-null deleted_at keeps the index tiny and is the right shape for
-- the admin "show deleted users" view; for the inverse (active users),
-- Postgres will do an index-anti-join / seqscan as appropriate.
CREATE INDEX IF NOT EXISTS idx_profiles_deleted_at
  ON public.profiles (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ── 3. RPC: admin_soft_delete_user ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_soft_delete_user(
  target_user_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_admin_id              UUID := auth.uid();
  v_previous_display_name TEXT;
  v_count                 INT;
BEGIN
  -- Stage 1: must be authenticated.
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_soft_delete_user: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  -- Stage 2: must be an admin.
  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_soft_delete_user: forbidden'
      USING ERRCODE = '42501';
  END IF;

  -- Argument validation.
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'admin_soft_delete_user: target_user_id is required'
      USING ERRCODE = '22023';
  END IF;

  -- Self-target guard. Blocking with 42501 (insufficient_privilege) is
  -- semantically correct: the acting admin is not authorized to perform
  -- this action against themselves, regardless of admin role.
  IF target_user_id = v_admin_id THEN
    RAISE EXCEPTION 'admin_soft_delete_user: cannot soft-delete self'
      USING ERRCODE = '42501';
  END IF;

  -- Capture the previous display_name BEFORE we scrub it, so the audit
  -- log row can record what the profile used to be called. We pull this
  -- in the same statement scope as the UPDATE to keep the snapshot
  -- consistent with what we're about to overwrite.
  SELECT display_name
    INTO v_previous_display_name
    FROM public.profiles
   WHERE user_id = target_user_id;

  -- Atomic soft-delete + PII scrub. Single UPDATE so deleted_at,
  -- display_name and avatar_url all transition together; partial state
  -- is impossible. Row count tells us whether the profile existed.
  UPDATE public.profiles
     SET deleted_at   = NOW(),
         display_name = NULL,
         avatar_url   = NULL,
         updated_at   = NOW()
   WHERE user_id = target_user_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Audit row. Always written (even when v_count = 0) so an attempt
  -- against a non-existent profile is still surfaced in the trail.
  -- Schema matches admin_resolve_all_flags / admin_cancel_job_with_refund.
  INSERT INTO public.admin_logs (
    admin_id,
    action,
    target_type,
    target_id,
    details
  ) VALUES (
    v_admin_id,
    'soft_delete_user',
    'user',
    target_user_id,
    jsonb_build_object(
      'previous_display_name', v_previous_display_name,
      'rows_affected',         v_count,
      'target_user_id',        target_user_id,
      'performed_by',          v_admin_id
    )
  );

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_soft_delete_user(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_soft_delete_user(UUID) TO authenticated;

COMMENT ON FUNCTION public.admin_soft_delete_user(UUID)
IS 'Admin-only: marks profiles.deleted_at = NOW() and scrubs PII (display_name, avatar_url) for target_user_id atomically, then writes one admin_logs row. Verifies is_admin(auth.uid()); refuses self-targeting (SQLSTATE 42501). Returns the number of profile rows affected (0 or 1). Reversible by clearing deleted_at and restoring display_name/avatar_url out-of-band — the original display_name is captured in the audit log details.';
