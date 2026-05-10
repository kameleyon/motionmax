-- ============================================================
-- C-6-10  Atlas F-D10:
-- Retroactive orphan-row sweep for user-scoped tables.
-- ============================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Several user-scoped tables (subscriptions, user_credits,
-- user_api_keys, credit_transactions, etc.) were created BEFORE
-- their `user_id → auth.users(id)` foreign keys were added. The
-- retroactive FK migrations were:
--   * 20260404000003_database_security_fixes  (subscriptions,
--     user_credits, credit_transactions, video_generation_jobs)
--   * 20260419000021_add_user_id_foreign_keys  (above plus
--     user_api_keys, project_characters, project_shares,
--     user_voices, user_flags, generation_archives,
--     generation_costs, api_call_logs, admin_logs)
--
-- 20260419000021 *did* purge orphans for the tables it touched
-- before adding FKs. However:
--
--   (a) The 2026-04-04 migration added FKs WITHOUT a prior orphan
--       sweep — it relied on `IF NOT EXISTS` guarding the ALTER,
--       so on databases where the FK already existed (Lovable-
--       seeded prod), no DELETE ran. On databases where the ALTER
--       *did* run, any pre-existing orphan would have caused the
--       ALTER itself to fail. Production has therefore had FKs
--       since 2026-04-04, but orphans deleted via the auth API
--       between earlier dates (when no FK was present and no
--       cleanup trigger ran for the destination table) may still
--       sit in the data.
--
--   (b) Tables created BEFORE 2026-04-04 with FKs added in
--       20260419000021 (e.g. user_api_keys, user_voices) had
--       their cleanup happen only once. Any DELETE FROM auth.users
--       that ran between 2026-04-04 and 2026-04-19 against those
--       tables would not have cascaded — leaving a second class
--       of orphans the 04-19 sweep already caught for the same
--       set of tables.
--
--   (c) Right-to-erasure ("GDPR Art. 17") deletions performed via
--       admin-tooling paths before 2026-04-04 deleted the auth.users
--       row but did not always reach satellite tables, especially
--       on the early days of the deletion-request feature.
--
-- This migration re-runs the orphan sweep across ALL user-scoped
-- tables now in the schema (a superset of what the 04-19 migration
-- touched), and installs a long-running assertion+cron pair so any
-- future regression is caught daily, not on the next quarterly
-- audit.
--
-- LEGAL POSTURE
-- -------------
-- Deleting these rows is *required* by GDPR Article 17 (right
-- to erasure). The owner account is already gone; the data is
-- stranded with no possible legitimate access path. Re-running
-- this cleanup is therefore unambiguously safe — it cannot
-- delete data belonging to a still-existing user.
-- ============================================================

-- ============================================================
-- Step 1: orphan-count detection (RAISE NOTICE per table) — runs
-- BEFORE the deletes so the migration log records what each
-- DELETE is about to remove.
-- ============================================================

DO $$
DECLARE
  c bigint;
BEGIN
  -- subscriptions (FK added 2026-04-04 OR 2026-04-19)
  SELECT COUNT(*) INTO c
  FROM public.subscriptions s
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id);
  RAISE NOTICE 'orphan count in subscriptions: %', c;

  -- user_credits (FK added 2026-04-04 OR 2026-04-19)
  SELECT COUNT(*) INTO c
  FROM public.user_credits u_c
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = u_c.user_id);
  RAISE NOTICE 'orphan count in user_credits: %', c;

  -- user_api_keys (FK added 2026-04-19)
  SELECT COUNT(*) INTO c
  FROM public.user_api_keys k
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = k.user_id);
  RAISE NOTICE 'orphan count in user_api_keys: %', c;

  -- credit_transactions
  SELECT COUNT(*) INTO c
  FROM public.credit_transactions t
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id);
  RAISE NOTICE 'orphan count in credit_transactions: %', c;

  -- project_characters
  SELECT COUNT(*) INTO c
  FROM public.project_characters pc
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = pc.user_id);
  RAISE NOTICE 'orphan count in project_characters: %', c;

  -- project_shares
  SELECT COUNT(*) INTO c
  FROM public.project_shares ps
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = ps.user_id);
  RAISE NOTICE 'orphan count in project_shares: %', c;

  -- user_voices
  SELECT COUNT(*) INTO c
  FROM public.user_voices uv
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = uv.user_id);
  RAISE NOTICE 'orphan count in user_voices: %', c;

  -- user_flags (user_id only — flagged_by/resolved_by use SET NULL by design)
  SELECT COUNT(*) INTO c
  FROM public.user_flags uf
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = uf.user_id);
  RAISE NOTICE 'orphan count in user_flags: %', c;

  -- video_generation_jobs
  SELECT COUNT(*) INTO c
  FROM public.video_generation_jobs j
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = j.user_id);
  RAISE NOTICE 'orphan count in video_generation_jobs: %', c;

  -- voice_consents (created 2026-04-19)
  IF to_regclass('public.voice_consents') IS NOT NULL THEN
    SELECT COUNT(*) INTO c
    FROM public.voice_consents vc
    WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = vc.user_id);
    RAISE NOTICE 'orphan count in voice_consents: %', c;
  END IF;

  -- autopost_social_accounts (created 2026-04-28)
  IF to_regclass('public.autopost_social_accounts') IS NOT NULL THEN
    SELECT COUNT(*) INTO c
    FROM public.autopost_social_accounts asa
    WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = asa.user_id);
    RAISE NOTICE 'orphan count in autopost_social_accounts: %', c;
  END IF;

  -- autopost_schedules
  IF to_regclass('public.autopost_schedules') IS NOT NULL THEN
    SELECT COUNT(*) INTO c
    FROM public.autopost_schedules sch
    WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = sch.user_id);
    RAISE NOTICE 'orphan count in autopost_schedules: %', c;
  END IF;
END $$;

-- ============================================================
-- Step 2: delete the orphans. Tables that already have ON DELETE
-- CASCADE FKs *should* be empty here — this is the retroactive
-- sweep for rows that snuck in before the FK existed.
-- ============================================================

DELETE FROM public.subscriptions       WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL);
DELETE FROM public.user_credits        WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL);
DELETE FROM public.user_api_keys       WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL);
DELETE FROM public.credit_transactions WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL);
DELETE FROM public.project_characters  WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL);
DELETE FROM public.project_shares      WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL);
DELETE FROM public.user_voices         WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL);
DELETE FROM public.user_flags          WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL);
DELETE FROM public.video_generation_jobs WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL);

DO $$
BEGIN
  IF to_regclass('public.voice_consents') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.voice_consents WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL)';
  END IF;

  IF to_regclass('public.autopost_social_accounts') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.autopost_social_accounts WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL)';
  END IF;

  IF to_regclass('public.autopost_schedules') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.autopost_schedules WHERE user_id NOT IN (SELECT id FROM auth.users WHERE id IS NOT NULL)';
  END IF;
END $$;

-- ============================================================
-- Step 3: post-delete assertion — final orphan count MUST be 0
-- for every table. If any non-zero count remains, fail the
-- migration so the operator investigates (could be a row with a
-- bogus NULL user_id that NOT IN doesn't catch, or a new table
-- not enumerated above).
-- ============================================================

DO $$
DECLARE
  total bigint := 0;
  c bigint;
BEGIN
  SELECT COUNT(*) INTO c FROM public.subscriptions s WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id);
  total := total + c;
  SELECT COUNT(*) INTO c FROM public.user_credits u_c WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = u_c.user_id);
  total := total + c;
  SELECT COUNT(*) INTO c FROM public.user_api_keys k WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = k.user_id);
  total := total + c;
  SELECT COUNT(*) INTO c FROM public.credit_transactions t WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id);
  total := total + c;
  SELECT COUNT(*) INTO c FROM public.project_characters pc WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = pc.user_id);
  total := total + c;
  SELECT COUNT(*) INTO c FROM public.project_shares ps WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = ps.user_id);
  total := total + c;
  SELECT COUNT(*) INTO c FROM public.user_voices uv WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = uv.user_id);
  total := total + c;
  SELECT COUNT(*) INTO c FROM public.user_flags uf WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = uf.user_id);
  total := total + c;
  SELECT COUNT(*) INTO c FROM public.video_generation_jobs j WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = j.user_id);
  total := total + c;

  IF total > 0 THEN
    RAISE EXCEPTION
      'Migration 20260510220000 assertion failed: % orphan row(s) remain after sweep. Investigate (likely a row with NULL user_id or a newly-added user-scoped table not enumerated in this migration).',
      total;
  END IF;
END $$;

-- ============================================================
-- Step 4: long-term assertion function. Reusable from cron, from
-- application code (Sentry breadcrumbs), or from ad-hoc psql
-- sessions. RAISEs a WARNING per offender and returns the total
-- count. Returns 0 in a healthy DB.
-- ============================================================

CREATE OR REPLACE FUNCTION public.assert_no_user_orphans()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  total bigint := 0;
  c bigint;
BEGIN
  -- Cascade-FK tables (should always be 0 once FKs are in place;
  -- a non-zero count here is a bug — likely a missing FK).
  SELECT COUNT(*) INTO c FROM public.subscriptions s WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id);
  IF c > 0 THEN RAISE WARNING 'orphan rows in subscriptions: %', c; total := total + c; END IF;

  SELECT COUNT(*) INTO c FROM public.user_credits u_c WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = u_c.user_id);
  IF c > 0 THEN RAISE WARNING 'orphan rows in user_credits: %', c; total := total + c; END IF;

  SELECT COUNT(*) INTO c FROM public.user_api_keys k WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = k.user_id);
  IF c > 0 THEN RAISE WARNING 'orphan rows in user_api_keys: %', c; total := total + c; END IF;

  SELECT COUNT(*) INTO c FROM public.credit_transactions t WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id);
  IF c > 0 THEN RAISE WARNING 'orphan rows in credit_transactions: %', c; total := total + c; END IF;

  SELECT COUNT(*) INTO c FROM public.project_characters pc WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = pc.user_id);
  IF c > 0 THEN RAISE WARNING 'orphan rows in project_characters: %', c; total := total + c; END IF;

  SELECT COUNT(*) INTO c FROM public.project_shares ps WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = ps.user_id);
  IF c > 0 THEN RAISE WARNING 'orphan rows in project_shares: %', c; total := total + c; END IF;

  SELECT COUNT(*) INTO c FROM public.user_voices uv WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = uv.user_id);
  IF c > 0 THEN RAISE WARNING 'orphan rows in user_voices: %', c; total := total + c; END IF;

  SELECT COUNT(*) INTO c FROM public.user_flags uf WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = uf.user_id);
  IF c > 0 THEN RAISE WARNING 'orphan rows in user_flags: %', c; total := total + c; END IF;

  SELECT COUNT(*) INTO c FROM public.video_generation_jobs j WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = j.user_id);
  IF c > 0 THEN RAISE WARNING 'orphan rows in video_generation_jobs: %', c; total := total + c; END IF;

  -- Optional tables (skip if not present in schema).
  IF to_regclass('public.voice_consents') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.voice_consents vc WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = vc.user_id)' INTO c;
    IF c > 0 THEN RAISE WARNING 'orphan rows in voice_consents: %', c; total := total + c; END IF;
  END IF;

  IF to_regclass('public.autopost_social_accounts') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.autopost_social_accounts a WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = a.user_id)' INTO c;
    IF c > 0 THEN RAISE WARNING 'orphan rows in autopost_social_accounts: %', c; total := total + c; END IF;
  END IF;

  IF to_regclass('public.autopost_schedules') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.autopost_schedules s WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = s.user_id)' INTO c;
    IF c > 0 THEN RAISE WARNING 'orphan rows in autopost_schedules: %', c; total := total + c; END IF;
  END IF;

  RETURN total;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_no_user_orphans() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_no_user_orphans() FROM anon;
REVOKE ALL ON FUNCTION public.assert_no_user_orphans() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assert_no_user_orphans() TO service_role;

COMMENT ON FUNCTION public.assert_no_user_orphans() IS
  'Returns the total count of orphaned rows (user_id references auth.users that no longer exist) across all user-scoped tables. Should always return 0 (Atlas F-D10 regression guard).';

-- ============================================================
-- Step 5: pg_cron daily check. Runs `assert_no_user_orphans()`
-- every night at 04:00 UTC (30 min after the existing log-purge
-- schedules at 03:00/03:30, to avoid contention). Any non-zero
-- result is logged via RAISE WARNING — Supabase forwards these
-- to the project logs, which the existing Sentry log-forwarding
-- integration picks up and surfaces as a Sentry breadcrumb.
--
-- Same idempotency pattern as 20260505140000_admin_phase2_cron_schedules:
-- guarded cron.unschedule first, then cron.schedule.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('assert-no-user-orphans-daily');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END $$;

SELECT cron.schedule(
  'assert-no-user-orphans-daily',
  '0 4 * * *',
  $$ SELECT public.assert_no_user_orphans(); $$
);
