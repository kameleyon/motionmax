-- ============================================================
-- Phase 8.2 — Last-active heartbeat
-- ============================================================
-- Live-RPC strategy (preferred over a nightly cron job): the client
-- calls bump_my_last_active() on focus + every 60 s while signed in,
-- which keeps the "active now" hero counter accurate to within ~1 min
-- without scanning system_logs nightly. The nightly UPDATE remains a
-- viable fallback for users who never visit the SPA, but the cron
-- piece is intentionally NOT wired up here — it can be added later if
-- needed.
--
-- profiles.last_active_at already exists (added in
-- 20260505160000_admin_phase2_schema_additions.sql).

BEGIN;

CREATE OR REPLACE FUNCTION public.bump_my_last_active()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'bump_my_last_active: no authenticated caller'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
     SET last_active_at = NOW()
   WHERE user_id = v_uid;
END;
$func$;

REVOKE ALL ON FUNCTION public.bump_my_last_active() FROM anon;
GRANT EXECUTE ON FUNCTION public.bump_my_last_active() TO authenticated;

COMMIT;
