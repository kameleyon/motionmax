-- ============================================================
-- C-6-5  Shield S-009 + Atlas:
-- Ensure every SECURITY DEFINER function pins search_path.
-- ============================================================
--
-- WHY (privilege-escalation footgun):
--   A SECURITY DEFINER function runs with the privileges of the
--   role that owns it (typically postgres / supabase_admin). If
--   the function's body references an unqualified object — e.g.
--   `SELECT ... FROM generations` instead of `FROM public.generations`
--   — name resolution follows the *caller's* search_path. An
--   attacker who can create a same-named temp object (a TABLE,
--   VIEW, or even another FUNCTION) inside a schema earlier in
--   search_path (for example `pg_temp` is always first when set)
--   can hijack the body's execution and run arbitrary SQL under
--   the definer's privileges.
--
--   The fix is to *pin* search_path on the function itself with
--   `SET search_path = public, pg_catalog`. Once attached as a
--   function-level GUC, the planner uses this list regardless of
--   the caller's session search_path. `pg_catalog` is put LAST so
--   user-defined functions in `public` can't be shadowed by a
--   builtin name collision, and `public` is put FIRST so the
--   function's own helpers (other public.* functions) resolve
--   without explicit schema qualification.
--
-- AUDIT FINDINGS (6 SECURITY DEFINER fns flagged by Shield S-009 /
-- Atlas review). After tracing each through subsequent migrations
-- the *current* live state is more nuanced than a flat "6 broken"
-- count — but this migration ALTERs every (name, signature) pair
-- that ever shipped without search_path, so the state is provably
-- correct regardless of replay order:
--
--   1. public.update_scene_field(uuid, int, text, text)
--        - introduced  20260318223400  (NO search_path)
--        - re-created  20260404000001  (WITH search_path)
--      Current live: fixed. ALTER below is idempotent.
--
--   2. public.update_scene_field_json(uuid, int, text, jsonb)
--        - introduced  20260406000001  (NO search_path)
--        - re-created  20260419000002  (WITH search_path)
--        - re-created  20260424200000  (WITH search_path)
--      Current live: fixed. ALTER below is idempotent.
--
--   3. public.cleanup_old_storage_objects(text, int)
--        - introduced  20260320210500  (NO search_path)
--        - never re-created with search_path.
--      Current live: STILL BROKEN — this migration is the fix.
--
--   4. public.claim_pending_job(text, text)                (v1)
--   5. public.claim_pending_job(text, text, integer)        (v2)
--   6. public.claim_pending_job(text, text, integer, text)  (v3)
--        - signature changed three times. The 20260407000001
--          definition of (text, text) shipped WITHOUT search_path.
--          Later versions (20260418..., 20260419..., 20260423...,
--          20260505..., 20260510...) all include search_path.
--      Current live: latest signature (text,text,integer,text) is
--      fixed. The older orphaned signatures may still exist in
--      schema if a DROP was missed. We ALTER each defensively;
--      ALTER on a non-existent signature is wrapped in DO/EXCEPTION
--      so the migration is safe to run.
--
-- DEFENSIVE STRATEGY: every ALTER FUNCTION below is wrapped in a
-- DO block that catches `undefined_function` so we never fail the
-- deploy if a historical signature has since been dropped.
-- ============================================================

DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER FUNCTION public.update_scene_field(uuid, integer, text, text) SET search_path = public, pg_catalog';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'update_scene_field(uuid, integer, text, text) does not exist — skipping';
  END;

  BEGIN
    EXECUTE 'ALTER FUNCTION public.update_scene_field_json(uuid, integer, text, jsonb) SET search_path = public, pg_catalog';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'update_scene_field_json(uuid, integer, text, jsonb) does not exist — skipping';
  END;

  BEGIN
    EXECUTE 'ALTER FUNCTION public.cleanup_old_storage_objects(text, integer) SET search_path = public, pg_catalog';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'cleanup_old_storage_objects(text, integer) does not exist — skipping';
  END;

  BEGIN
    EXECUTE 'ALTER FUNCTION public.claim_pending_job(text, text) SET search_path = public, pg_catalog';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'claim_pending_job(text, text) does not exist — skipping';
  END;

  BEGIN
    EXECUTE 'ALTER FUNCTION public.claim_pending_job(text, text, integer) SET search_path = public, pg_catalog';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'claim_pending_job(text, text, integer) does not exist — skipping';
  END;

  BEGIN
    EXECUTE 'ALTER FUNCTION public.claim_pending_job(text, text, integer, text) SET search_path = public, pg_catalog';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'claim_pending_job(text, text, integer, text) does not exist — skipping';
  END;
END $$;

-- ============================================================
-- Belt-and-suspenders: scan pg_proc at migration time. If any
-- SECURITY DEFINER function in `public` STILL lacks search_path
-- after the ALTERs above, RAISE EXCEPTION so the deploy fails
-- loud rather than silently leaving a footgun in place.
--
-- The query below joins pg_proc → pg_namespace and inspects
-- proconfig (a text[] of GUC settings attached to the function).
-- A nil proconfig means "no GUCs pinned"; a proconfig that does
-- not contain a `search_path=` entry also fails.
-- ============================================================

DO $$
DECLARE
  bad_fn record;
  bad_count integer := 0;
BEGIN
  FOR bad_fn IN
    SELECT n.nspname  AS schema_name,
           p.proname  AS function_name,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef IS TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
        WHERE cfg ILIKE 'search_path=%'
      )
  LOOP
    bad_count := bad_count + 1;
    RAISE WARNING 'SECURITY DEFINER without search_path: %.%(%)',
      bad_fn.schema_name, bad_fn.function_name, bad_fn.args;
  END LOOP;

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Migration 20260510200000 assertion failed: % SECURITY DEFINER function(s) in public.* still lack a pinned search_path. See WARNINGs above. Add `SET search_path = public, pg_catalog` to each, or ALTER FUNCTION ... SET search_path = ... in a follow-up migration.',
      bad_count;
  END IF;
END $$;

-- ============================================================
-- assert_security_definer_search_path()
-- Ad-hoc reverification helper. Same query as the DO block above
-- but callable from psql / Supabase SQL editor for spot checks
-- on a running DB. Returns the count of offenders (0 = clean).
-- ============================================================

CREATE OR REPLACE FUNCTION public.assert_security_definer_search_path()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  offender_count integer;
BEGIN
  SELECT COUNT(*) INTO offender_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef IS TRUE
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
      WHERE cfg ILIKE 'search_path=%'
    );

  IF offender_count > 0 THEN
    RAISE WARNING
      'SECURITY DEFINER without search_path detected: % function(s). Run: SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname=''public'' AND p.prosecdef AND (p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c ILIKE ''search_path=%%''));',
      offender_count;
  END IF;

  RETURN offender_count;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_security_definer_search_path() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_security_definer_search_path() FROM anon;
REVOKE ALL ON FUNCTION public.assert_security_definer_search_path() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assert_security_definer_search_path() TO service_role;

COMMENT ON FUNCTION public.assert_security_definer_search_path() IS
  'Returns the count of public.* SECURITY DEFINER functions that lack a pinned search_path (Shield S-009 / Atlas C-6-5). Should always return 0 in a healthy schema.';
