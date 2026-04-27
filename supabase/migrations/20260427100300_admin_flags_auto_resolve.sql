-- Migration: admin_flags_auto_resolve
--
-- Problem: Active user_flags accumulate without bound. Operators leave
-- low-severity flags (warnings, low-confidence flagged rows) sitting in
-- the active list forever, which makes the AdminFlags scannable list
-- noisy and pushes genuinely-needs-attention rows below the fold. There
-- is no current mechanism for time-based auto-resolution.
--
-- Fix: a daily pg_cron job that resolves any user_flags row whose
-- created_at is older than a configurable threshold (default 30 days)
-- and is still active (resolved_at IS NULL). The threshold is stored
-- in a new app_settings key/value table and is admin-mutable through
-- a SECURITY DEFINER RPC. The cron-invoked function is REVOKED from
-- PUBLIC/authenticated so only the scheduler (postgres role) and
-- service_role can run it; admins do not auto-resolve manually.
--
-- Re-running the migration is safe: app_settings is created if-not-
-- exists, the seed row uses ON CONFLICT DO NOTHING, the RPC and worker
-- are CREATE OR REPLACE, and cron.schedule with the same job name
-- updates the existing schedule rather than duplicating it.
--
-- Pattern references:
--   * Admin RPC + is_admin(auth.uid()) gate + 42501 raises mirror
--     20260425600000_admin_cancel_job_with_refund.sql and
--     20260427100000_admin_resolve_all_flags.sql exactly.
--   * cron.schedule usage matches 20260320210200_add_deletion_processing.sql
--     and 20260419000020_schedule_deletion_drain.sql.
--   * user_flags column semantics (resolved_at, resolved_by,
--     resolution_notes) match the resolve_flag / admin_resolve_all_flags
--     paths.

-- ----------------------------------------------------------------
-- 1. app_settings: generic key/value config store.
--    Created idempotently. Admins read/write only via SECURITY DEFINER
--    RPCs; direct table access is restricted to service_role.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Drop-then-create so the policy is idempotent across re-runs.
DROP POLICY IF EXISTS "service_role manages app_settings" ON public.app_settings;
CREATE POLICY "service_role manages app_settings"
  ON public.app_settings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.app_settings
IS 'Generic admin-managed key/value config (jsonb). Direct access is service_role only; admins read/write via SECURITY DEFINER RPCs.';

-- ----------------------------------------------------------------
-- 2. Seed the auto-resolve threshold (default 30 days).
--    ON CONFLICT DO NOTHING preserves any operator-tuned value across
--    repeat migration runs.
-- ----------------------------------------------------------------
INSERT INTO public.app_settings (key, value)
VALUES ('flags_auto_resolve_days', to_jsonb(30))
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------
-- 3. Admin RPC: set the auto-resolve threshold.
--    Bounded to [1, 365] days. Authorization mirrors
--    admin_resolve_all_flags exactly.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_flags_auto_resolve_days(
  days INT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_set_flags_auto_resolve_days: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_set_flags_auto_resolve_days: forbidden'
      USING ERRCODE = '42501';
  END IF;

  IF days IS NULL OR days < 1 OR days > 365 THEN
    RAISE EXCEPTION 'admin_set_flags_auto_resolve_days: days must be between 1 and 365 (got %)', days
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.app_settings (key, value, updated_at)
  VALUES ('flags_auto_resolve_days', to_jsonb(days), NOW())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = NOW();

  -- Audit row so changes to the auto-resolve window are traceable.
  INSERT INTO public.admin_logs (
    admin_id,
    action,
    target_type,
    target_id,
    details
  ) VALUES (
    v_admin_id,
    'set_flags_auto_resolve_days',
    'app_setting',
    NULL,
    jsonb_build_object(
      'key',          'flags_auto_resolve_days',
      'days',         days,
      'performed_by', v_admin_id
    )
  );

  RETURN days;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_flags_auto_resolve_days(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_flags_auto_resolve_days(INT) TO authenticated;

COMMENT ON FUNCTION public.admin_set_flags_auto_resolve_days(INT)
IS 'Admin-only: upserts the flags_auto_resolve_days app_settings row. Validates 1..365. Verifies is_admin(auth.uid()) at entry. Writes an admin_logs row. Returns the persisted day count.';

-- ----------------------------------------------------------------
-- 4. Worker: auto_resolve_stale_flags()
--    Reads the configured day threshold, bulk-resolves any active
--    user_flags whose created_at is older than NOW() - threshold, and
--    returns the affected row count. resolved_by is left NULL to mark
--    the action as a system / non-human resolve, consistent with the
--    'auto_resolved' resolution_notes prefix.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_resolve_stale_flags()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days  INT;
  v_count INT;
BEGIN
  -- jsonb cannot cast directly to int in Postgres -- the value was stored
  -- as a json number via to_jsonb(30), so we coerce through text. Using
  -- (value#>>'{}') extracts the scalar as text regardless of nesting.
  SELECT (value#>>'{}')::int
    INTO v_days
    FROM public.app_settings
   WHERE key = 'flags_auto_resolve_days';

  -- Defensive default: if the row was deleted out from under us, fall
  -- back to 30 rather than no-op silently or error the cron job.
  IF v_days IS NULL OR v_days < 1 THEN
    v_days := 30;
  END IF;

  UPDATE public.user_flags
     SET resolved_at      = NOW(),
         resolved_by      = NULL,
         resolution_notes = 'auto_resolved (stale >' || v_days || 'd)',
         updated_at       = NOW()
   WHERE resolved_at IS NULL
     AND created_at < NOW() - (v_days || ' days')::interval;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

-- Cron runs as the postgres role (effectively service_role-equivalent
-- for execution). PUBLIC / anon / authenticated must NOT be able to
-- bulk-resolve every user's stale flags.
REVOKE ALL ON FUNCTION public.auto_resolve_stale_flags() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_resolve_stale_flags() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_resolve_stale_flags() TO service_role;

COMMENT ON FUNCTION public.auto_resolve_stale_flags()
IS 'System-only: bulk-resolves any active (resolved_at IS NULL) user_flags row whose created_at is older than app_settings.flags_auto_resolve_days. Sets resolved_by=NULL and resolution_notes=''auto_resolved (stale >Xd)''. Returns the number of rows resolved. Invoked by pg_cron daily at 03:00 UTC.';

-- ----------------------------------------------------------------
-- 5. Schedule the daily cron job at 03:00 UTC.
--    cron.schedule with an existing jobname updates the schedule in
--    place, so this is safe to re-run.
-- ----------------------------------------------------------------
SELECT cron.schedule(
  'auto-resolve-stale-flags',
  '0 3 * * *',
  $$SELECT public.auto_resolve_stale_flags()$$
);
