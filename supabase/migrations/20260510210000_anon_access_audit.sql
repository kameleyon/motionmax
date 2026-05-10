-- ============================================================
-- C-6-9  Atlas F-D9:
-- worker_anon_access RLS incident — post-mortem, current-state
-- verification, and ad-hoc assertion helper.
-- ============================================================
--
-- INCIDENT TIMELINE
-- -----------------
-- 2026-03-08 21:07 UTC  Migration 20260308210700_worker_anon_access
--                       shipped 4 policies on video_generation_jobs
--                       with `USING (true)` and NO role qualifier
--                       (i.e. effective for both anon AND
--                       authenticated). For ~48h, any caller with
--                       the anon key could SELECT / INSERT / UPDATE
--                       / DELETE every row in the table.
--
-- 2026-03-10 00:00 UTC  Migration 20260310000001_fix_rls_video_generation_jobs
--                       dropped the four blanket policies. Replaced
--                       SELECT/INSERT with auth.uid()-scoped policies
--                       for `authenticated`, BUT also created
--                       anon_worker_select_jobs / anon_worker_update_jobs
--                       with `USING (true) TO anon` — so anon could
--                       still SELECT and UPDATE every row. The
--                       "fix" only closed the authenticated leak.
--
-- 2026-03-20 21:01 UTC  Migration 20260320210100_remove_anon_worker_policies
--                       dropped the remaining permissive anon
--                       policies. From this point on, anon has
--                       NO policy on video_generation_jobs — RLS
--                       denies by default. The worker is the only
--                       legitimate writer and it uses service_role
--                       which bypasses RLS.
--
-- 2026-04-19 20:00 UTC  Migration 20260419200002_unify_video_jobs_policies
--                       reconciled the policy set into a clean
--                       three-policy state (the current state):
--                         authenticated SELECT user_id = auth.uid()
--                         authenticated INSERT user_id = auth.uid()
--                         service_role  ALL    USING (true)
--                       Note: service_role's USING (true) is the
--                       ONLY remaining USING(true) on this table —
--                       safe because service_role is privileged.
--
-- BLAST RADIUS
-- ------------
-- During the 2026-03-08 → 2026-03-10 window (and to a reduced
-- degree until 2026-03-20), an attacker holding the anon key
-- (which is public — embedded in the frontend bundle) could:
--   * Enumerate every queued generation job and read its payload
--     (prompts, scene descriptors — no PII per se, but production
--     content)
--   * Mutate job status (could mark jobs failed, blocking users
--     from getting their videos)
--   * NOT exfiltrate auth tokens or financial data — those live
--     in separate tables that always had tight RLS.
--
-- FORENSIC CHECK
-- --------------
-- The `system_logs` table (created 2026-02-01) is application-
-- level logging — it records what our code does, not what
-- arbitrary anon-key callers do. There is no Postgres-level
-- statement audit log on this project (pgAudit is not enabled
-- and would have been retroactive anyway).
--
-- CONCLUSION: no audit data exists for the 48h window. The leak
-- is bounded by:
--   (a) the 48h duration, then a 10-day reduced-scope window,
--   (b) the anon key's known scope (frontend-embedded, treated
--       as public from the start),
--   (c) the absence of indicators in user-visible job records
--       (no users reported missing/altered job state during the
--       window — checked against support-ticket archive).
--
-- This migration:
--   1. Verifies the CURRENT policy set on video_generation_jobs
--      is the canonical three-policy state and drops any policy
--      that has crept back in with USING(true) for anon/auth.
--   2. Installs `assert_no_permissive_anon_policies()` for ad-hoc
--      verification — does NOT add a runtime constraint.
--
-- A *forward-looking* CI lint that fails any future migration
-- containing `USING (true)` for anon/authenticated lives in
-- scripts/lint-rls-permissive.mjs and is wired into ci.yml.
-- ============================================================

-- ============================================================
-- Step 1: drop any permissive anon/authenticated USING(true)
-- policy that may have been reintroduced. Idempotent.
-- ============================================================

-- Names that ever existed (per migration history) — drop if present.
DROP POLICY IF EXISTS "worker_read_jobs"        ON public.video_generation_jobs;
DROP POLICY IF EXISTS "worker_insert_jobs"      ON public.video_generation_jobs;
DROP POLICY IF EXISTS "worker_update_jobs"      ON public.video_generation_jobs;
DROP POLICY IF EXISTS "worker_delete_jobs"      ON public.video_generation_jobs;
DROP POLICY IF EXISTS "anon_worker_select_jobs" ON public.video_generation_jobs;
DROP POLICY IF EXISTS "anon_worker_update_jobs" ON public.video_generation_jobs;

-- LIVE REGRESSION FOUND DURING AUDIT (2026-05-10):
-- Migration 20260419320000_consolidate_rls_policies.sql silently
-- recreated `vgj_anon_select` and `vgj_anon_update` with
-- `USING (true) TO anon` AFTER the 2026-03-20 removal and AFTER
-- the 2026-04-19 14:00 unify_video_jobs_policies cleanup. No
-- subsequent migration dropped them. Anon has had SELECT + UPDATE
-- on every video_generation_jobs row since 2026-04-19 17:20 UTC.
-- These DROPs close that window.
DROP POLICY IF EXISTS "vgj_anon_select" ON public.video_generation_jobs;
DROP POLICY IF EXISTS "vgj_anon_update" ON public.video_generation_jobs;
DROP POLICY IF EXISTS "vgj_auth_select" ON public.video_generation_jobs;
DROP POLICY IF EXISTS "vgj_auth_insert" ON public.video_generation_jobs;

-- Re-assert the canonical three-policy state from 20260419200002,
-- which 20260419320000 trampled. Idempotent — only creates the
-- policy if a matching one doesn't already exist (by name).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'video_generation_jobs'
      AND policyname = 'authenticated_select_own_jobs'
  ) THEN
    CREATE POLICY "authenticated_select_own_jobs"
      ON public.video_generation_jobs
      FOR SELECT
      TO authenticated
      USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'video_generation_jobs'
      AND policyname = 'authenticated_insert_own_jobs'
  ) THEN
    CREATE POLICY "authenticated_insert_own_jobs"
      ON public.video_generation_jobs
      FOR INSERT
      TO authenticated
      WITH CHECK (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'video_generation_jobs'
      AND policyname = 'service_role_full_access_jobs'
  ) THEN
    CREATE POLICY "service_role_full_access_jobs"
      ON public.video_generation_jobs
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- Generic guard: if ANY policy on video_generation_jobs is
-- scoped to anon / authenticated / public AND has either
-- USING(true) or WITH CHECK(true), drop it. `qual` and `with_check`
-- are deparsed to text in pg_policies — Postgres normalises to the
-- string 'true' for a literal true expression.
DO $$
DECLARE
  bad record;
BEGIN
  FOR bad IN
    SELECT policyname, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'video_generation_jobs'
      AND (qual = 'true' OR with_check = 'true')
      AND (
        'anon' = ANY (roles)
        OR 'public' = ANY (roles)
        OR 'authenticated' = ANY (roles)
      )
  LOOP
    RAISE WARNING
      'Dropping reintroduced permissive policy "%": roles=% qual=% check=%',
      bad.policyname, bad.roles, bad.qual, bad.with_check;
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.video_generation_jobs',
      bad.policyname
    );
  END LOOP;
END $$;

-- ============================================================
-- Step 2: assertion helper. NOT scheduled — call manually to
-- spot-check the live DB or run from a deploy hook.
--
--   SELECT public.assert_no_permissive_anon_policies();
--
-- Returns the count of offending policies (0 = clean). RAISEs a
-- WARNING for each offender for log-grep-ability. Does NOT throw,
-- so it's safe to call from monitoring code.
-- ============================================================

CREATE OR REPLACE FUNCTION public.assert_no_permissive_anon_policies()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  offender_count integer := 0;
  bad record;
BEGIN
  FOR bad IN
    SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        -- Permissive USING clause
        qual = 'true'
        -- Permissive WITH CHECK clause
        OR with_check = 'true'
      )
      AND (
        'anon'          = ANY (roles)
        OR 'public'     = ANY (roles)
        OR 'authenticated' = ANY (roles)
      )
  LOOP
    offender_count := offender_count + 1;
    RAISE WARNING
      'Permissive anon/auth policy detected: %.% policy=% cmd=% roles=% using=% check=%',
      bad.schemaname, bad.tablename, bad.policyname, bad.cmd,
      bad.roles, bad.qual, bad.with_check;
  END LOOP;

  RETURN offender_count;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_no_permissive_anon_policies() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_no_permissive_anon_policies() FROM anon;
REVOKE ALL ON FUNCTION public.assert_no_permissive_anon_policies() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assert_no_permissive_anon_policies() TO service_role;

COMMENT ON FUNCTION public.assert_no_permissive_anon_policies() IS
  'Returns the count of RLS policies in public.* that grant USING(true) or WITH CHECK(true) to anon / authenticated / public roles. Should always return 0 (Atlas F-D9 regression guard).';

-- ============================================================
-- Step 3: deploy-time assertion. Narrowly checks that
-- video_generation_jobs — the table this incident is about — has
-- NO permissive anon/auth policy. Does NOT use the broader helper
-- because other tables (referral_codes, promo_codes) ship
-- intentional anon read-by-token policies that the lint
-- allowlists in source. A separate cleanup migration can address
-- the cross-table sweep when each call site has been reviewed.
-- ============================================================

DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'video_generation_jobs'
    AND (qual = 'true' OR with_check = 'true')
    AND (
      'anon' = ANY (roles)
      OR 'public' = ANY (roles)
      OR 'authenticated' = ANY (roles)
    );

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 20260510210000 assertion failed: % permissive anon/auth policy(ies) on video_generation_jobs remain after cleanup.',
      bad_count;
  END IF;
END $$;
