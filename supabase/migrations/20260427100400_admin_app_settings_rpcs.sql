-- Migration: admin_app_settings_rpcs
--
-- Problem: 20260427100300_admin_flags_auto_resolve.sql created the
-- public.app_settings table as service_role-only (RLS allows ALL only
-- to service_role). That's correct for direct table access, but it
-- means admins authenticated via JWT cannot read or list settings from
-- the dashboard. Wave 2 needs:
--
--   * Vega's admin slider must read flags_auto_resolve_days (already
--     seeded) and worker_concurrency_override (seeded here) so the UI
--     can render the current value before the admin changes it.
--   * The worker (worker/src/index.ts) currently fixes its concurrency
--     at startup from process.env.WORKER_CONCURRENCY with an auto-tune
--     fallback. To bump/cut concurrency without a deploy, we store an
--     override in app_settings under 'worker_concurrency_override'
--     (jsonb int, or jsonb null meaning "use auto-tune / env default").
--     The Wave 2 worker change will poll this value periodically; the
--     worker code is NOT touched in this migration.
--
-- Fix: SECURITY DEFINER RPCs that gate on is_admin(auth.uid()), search-
-- path-locked, REVOKE from public + GRANT to authenticated. Reads are
-- not audit-logged (would be noisy); writes are.
--
-- Authorization mirrors admin_resolve_all_flags exactly: two-stage
-- check (auth.uid() IS NULL -> 42501; NOT is_admin(auth.uid()) -> 42501)
-- with the same SQLSTATE. admin_logs columns (admin_id, action,
-- target_type, target_id, details) match the existing schema used by
-- admin_resolve_all_flags and admin_set_flags_auto_resolve_days.
--
-- Re-running the migration is safe: RPCs use CREATE OR REPLACE, the
-- seed insert uses ON CONFLICT DO NOTHING.

-- ----------------------------------------------------------------
-- Task A.1 -- admin_get_app_setting(setting_key text) -> jsonb
--   Admin-only single-key reader. Returns the stored value jsonb, or
--   NULL if the row is absent. No audit log (reads are noisy).
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_app_setting(
  setting_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_value    JSONB;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_get_app_setting: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_get_app_setting: forbidden'
      USING ERRCODE = '42501';
  END IF;

  IF setting_key IS NULL OR length(setting_key) = 0 THEN
    RAISE EXCEPTION 'admin_get_app_setting: setting_key is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT value
    INTO v_value
    FROM public.app_settings
   WHERE key = setting_key;

  RETURN v_value;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_app_setting(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_get_app_setting(TEXT) TO authenticated;

COMMENT ON FUNCTION public.admin_get_app_setting(TEXT)
IS 'Admin-only: returns the value jsonb for the given app_settings key, or NULL if absent. Verifies is_admin(auth.uid()) at entry. Not audit-logged (reads).';

-- ----------------------------------------------------------------
-- Task A.2 -- admin_list_app_settings() -> table(...)
--   Admin-only full-table reader for a future settings page. Returns
--   every row. Not audit-logged.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_app_settings()
RETURNS TABLE (
  key        TEXT,
  value      JSONB,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_list_app_settings: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_list_app_settings: forbidden'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT s.key, s.value, s.updated_at
      FROM public.app_settings s
     ORDER BY s.key;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_app_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_app_settings() TO authenticated;

COMMENT ON FUNCTION public.admin_list_app_settings()
IS 'Admin-only: returns all rows from app_settings (key, value, updated_at). Verifies is_admin(auth.uid()) at entry. Not audit-logged (reads).';

-- ----------------------------------------------------------------
-- Task B.3 -- Seed worker_concurrency_override.
--   jsonb null = "no override; worker should use auto-tune / env
--   default". ON CONFLICT DO NOTHING preserves any operator-tuned
--   value across repeat migration runs.
-- ----------------------------------------------------------------
INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('worker_concurrency_override', 'null'::jsonb, NOW())
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------
-- Task B.4 -- admin_set_worker_concurrency_override(value int) -> jsonb
--   Admin-only setter for the runtime worker concurrency override.
--     * NULL or <= 0 => store jsonb null (revert to auto-tune)
--     * 1..64        => store as jsonb int
--     * > 64 or < 0  => 22023
--   Audit-logs the change with the previous and new value. Returns the
--   stored value as jsonb (null or the int).
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_worker_concurrency_override(
  value INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_old      JSONB;
  v_new      JSONB;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_set_worker_concurrency_override: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_set_worker_concurrency_override: forbidden'
      USING ERRCODE = '42501';
  END IF;

  -- Decide the new stored value.
  IF value IS NULL OR value <= 0 THEN
    -- Treat any null / non-positive input as "revert to auto-tune".
    v_new := 'null'::jsonb;
  ELSE
    -- Positive => must fit the allowed runtime band.
    IF value < 1 OR value > 64 THEN
      RAISE EXCEPTION 'admin_set_worker_concurrency_override: value must be between 1 and 64 (got %)', value
        USING ERRCODE = '22023';
    END IF;
    v_new := to_jsonb(value);
  END IF;

  -- Capture the prior value for the audit row before we overwrite it.
  SELECT s.value
    INTO v_old
    FROM public.app_settings s
   WHERE s.key = 'worker_concurrency_override';

  INSERT INTO public.app_settings (key, value, updated_at)
  VALUES ('worker_concurrency_override', v_new, NOW())
  ON CONFLICT (key) DO UPDATE
    SET value      = EXCLUDED.value,
        updated_at = NOW();

  INSERT INTO public.admin_logs (
    admin_id,
    action,
    target_type,
    target_id,
    details
  ) VALUES (
    v_admin_id,
    'set_worker_concurrency_override',
    'app_setting',
    NULL,
    jsonb_build_object(
      'key',          'worker_concurrency_override',
      'old',          v_old,
      'new',          v_new,
      'performed_by', v_admin_id
    )
  );

  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_worker_concurrency_override(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_worker_concurrency_override(INT) TO authenticated;

COMMENT ON FUNCTION public.admin_set_worker_concurrency_override(INT)
IS 'Admin-only: upserts app_settings.worker_concurrency_override. NULL or <= 0 stores jsonb null (revert to auto-tune); positive values must be 1..64 and store as jsonb int. Verifies is_admin(auth.uid()) at entry. Writes an admin_logs row with {old,new}. Returns the stored jsonb value.';
