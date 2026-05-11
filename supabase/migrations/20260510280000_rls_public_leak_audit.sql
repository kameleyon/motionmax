-- ============================================================
-- RLS-PUBLIC-leak audit follow-up (Task #83, §6-C)
-- ============================================================
-- The §6-C audit flagged four internal tables that had RLS enabled
-- but at least one policy missing a `TO <role>` clause, which means
-- the policy applies to PUBLIC. Combined with a default `GRANT SELECT
-- ... TO anon` on `public.*` from PostgREST's role chain, that's a
-- public-leak in the making.
--
-- The 4 tables and their real producers/consumers:
--   1. auth_events       — scaffold table for session derivation.
--                          No app code currently writes to it. When
--                          we wire it up it will be from edge
--                          functions using service_role.
--   2. generation_costs  — worker (service_role) inserts cost rollups
--                          per video generation. Admin UI reads via
--                          adminDirectQueries.ts -> Edge Function
--                          using service_role.
--   3. api_call_logs     — worker `lib/logger.ts` inserts per-LLM
--                          call rows via service_role. Admin UI
--                          reads through service_role edge funcs.
--   4. admin_logs        — admin Edge Functions write via service_role
--                          (adminDirectQueries.ts). No client-side
--                          inserts.
--
-- All four tables are worker-write + admin-read via service_role.
-- No end-user UI reads from them directly, so a service-role-only
-- lockdown is safe.
--
-- Post-condition (enforced by the DO $verify$ block at the bottom):
--   No remaining policy on any of these 4 tables grants `anon`,
--   `authenticated`, or PUBLIC. If any leak survives the migration
--   the transaction RAISEs and rolls back.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- Helper: dynamically drop every existing policy on a table.
-- Avoids hard-coding the historic policy names (which have drifted
-- across multiple earlier migrations: "Service role can write
-- auth_events", "Admins can view all api_call_logs",
-- "gen_costs_select", "admin_logs_select", etc.)
-- ────────────────────────────────────────────────────────────
DO $drop_all$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT policyname, schemaname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'auth_events',
        'generation_costs',
        'api_call_logs',
        'admin_logs'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      r.policyname, r.schemaname, r.tablename
    );
  END LOOP;
END;
$drop_all$;

-- ────────────────────────────────────────────────────────────
-- 1. auth_events — service_role only
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.auth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_events FORCE  ROW LEVEL SECURITY;

REVOKE ALL ON public.auth_events FROM anon, authenticated, PUBLIC;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.auth_events TO service_role;

CREATE POLICY auth_events_service_role_only
  ON public.auth_events
  AS RESTRICTIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Permissive companion so service_role actually matches a row.
-- (Without a permissive policy, ALL rows are denied even to
-- service_role because the only policy is RESTRICTIVE.)
CREATE POLICY auth_events_service_role_all
  ON public.auth_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.auth_events IS
  'Auth audit trail (signin/signout/MFA). service_role only — see migration 20260510280000.';

-- ────────────────────────────────────────────────────────────
-- 2. generation_costs — service_role only
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.generation_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generation_costs FORCE  ROW LEVEL SECURITY;

REVOKE ALL ON public.generation_costs FROM anon, authenticated, PUBLIC;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.generation_costs TO service_role;

CREATE POLICY generation_costs_service_role_only
  ON public.generation_costs
  AS RESTRICTIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY generation_costs_service_role_all
  ON public.generation_costs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.generation_costs IS
  'Per-generation cost rollup. service_role only — admin UI reads via Edge Functions.';

-- ────────────────────────────────────────────────────────────
-- 3. api_call_logs — service_role only
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.api_call_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_call_logs FORCE  ROW LEVEL SECURITY;

REVOKE ALL ON public.api_call_logs FROM anon, authenticated, PUBLIC;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.api_call_logs TO service_role;

CREATE POLICY api_call_logs_service_role_only
  ON public.api_call_logs
  AS RESTRICTIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY api_call_logs_service_role_all
  ON public.api_call_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.api_call_logs IS
  'Per-LLM-call cost telemetry. service_role only — see migration 20260510280000.';

-- ────────────────────────────────────────────────────────────
-- 4. admin_logs — service_role only
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.admin_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_logs FORCE  ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_logs FROM anon, authenticated, PUBLIC;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.admin_logs TO service_role;

CREATE POLICY admin_logs_service_role_only
  ON public.admin_logs
  AS RESTRICTIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY admin_logs_service_role_all
  ON public.admin_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.admin_logs IS
  'Admin action audit log. service_role only — admin UI reads via Edge Functions (adminDirectQueries.ts, Wave 7).';

-- ────────────────────────────────────────────────────────────
-- Verification: post-condition gate.
-- Fails the migration if ANY remaining policy on the 4 tables
-- still references anon / authenticated / PUBLIC.
-- ────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  leak_count int;
  grant_leak int;
BEGIN
  SELECT count(*) INTO leak_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'auth_events',
      'generation_costs',
      'api_call_logs',
      'admin_logs'
    )
    AND (
      'anon'          = ANY(roles)
      OR 'authenticated' = ANY(roles)
      OR 'public'        = ANY(roles)
      OR 'PUBLIC'        = ANY(roles)
    );

  IF leak_count > 0 THEN
    RAISE EXCEPTION
      'RLS-PUBLIC-leak migration: % policies still grant anon/authenticated/PUBLIC',
      leak_count;
  END IF;

  -- Also verify no table-level grants remain to anon/authenticated.
  SELECT count(*) INTO grant_leak
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN (
      'auth_events',
      'generation_costs',
      'api_call_logs',
      'admin_logs'
    )
    AND grantee IN ('anon', 'authenticated', 'PUBLIC');

  IF grant_leak > 0 THEN
    RAISE EXCEPTION
      'RLS-PUBLIC-leak migration: % table-level grants still exist to anon/authenticated/PUBLIC',
      grant_leak;
  END IF;

  RAISE NOTICE
    'RLS-PUBLIC-leak migration: verification passed (0 leaks across 4 tables)';
END;
$verify$;

COMMIT;
