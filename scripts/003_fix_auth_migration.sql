-- ============================================================
-- 003_fix_auth_migration.sql
-- Reconnects ALL user data to new auth.users UUIDs after
-- a database + auth migration where UUIDs changed.
--
-- HOW IT WORKS:
--   1. Builds old→new user_id mapping via email↔display_name
--   2. Disables FK triggers (session_replication_role)
--   3. Handles UNIQUE conflicts (profiles, user_credits, etc.)
--   4. Updates user_id in every table
--   5. Merges duplicate profiles (keeps original created_at)
--   6. Re-enables triggers & verifies
--
-- RUN: Paste into Supabase SQL Editor → Run
-- PREREQUISITE: Run 002_diagnose_migration.sql first to verify
-- ============================================================

BEGIN;

-- ── 0. Disable FK checks & triggers for this session ──────
SET session_replication_role = 'replica';

-- ── 1. Build the old→new user_id mapping ──────────────────
CREATE TEMP TABLE user_id_map (
  old_user_id UUID NOT NULL,
  new_user_id UUID NOT NULL,
  display_name TEXT,
  email TEXT,
  PRIMARY KEY (old_user_id)
);

-- Auto-map: orphaned profile display_name matches auth.users
-- email prefix or raw_user_meta_data->>'full_name'
INSERT INTO user_id_map (old_user_id, new_user_id, display_name, email)
SELECT DISTINCT ON (old_p.user_id)
  old_p.user_id,
  au.id,
  old_p.display_name,
  au.email
FROM profiles old_p
LEFT JOIN auth.users au_check ON au_check.id = old_p.user_id
CROSS JOIN auth.users au
WHERE au_check.id IS NULL                          -- only orphaned profiles
  AND au.id NOT IN (SELECT user_id FROM profiles)  -- only unlinked auth users
  AND (
    lower(trim(old_p.display_name))
      = lower(trim(split_part(au.email, '@', 1)))
    OR lower(trim(old_p.display_name))
      = lower(trim(COALESCE(au.raw_user_meta_data->>'full_name', '')))
    OR lower(trim(old_p.display_name))
      = lower(trim(COALESCE(au.raw_user_meta_data->>'display_name', '')))
    OR lower(regexp_replace(old_p.display_name, '[^a-z0-9]', '', 'gi'))
      = lower(regexp_replace(split_part(au.email, '@', 1), '[^a-z0-9]', '', 'gi'))
  )
ORDER BY old_p.user_id, au.created_at ASC;

-- ══════════════════════════════════════════════════════════
-- ┌──────────────────────────────────────────────────────┐
-- │  MANUAL MAPPING — fill in if auto-map missed anyone  │
-- │  Uncomment and add rows:                             │
-- │                                                      │
-- │  INSERT INTO user_id_map VALUES                      │
-- │  ('old-uuid', 'new-uuid', 'name', 'email@x.com')    │
-- │  ON CONFLICT (old_user_id) DO NOTHING;               │
-- └──────────────────────────────────────────────────────┘
-- ══════════════════════════════════════════════════════════

-- ── 1b. Report mapping ───────────────────────────────────
DO $$
DECLARE
  mapped INT; orphaned INT;
BEGIN
  SELECT COUNT(*) INTO mapped FROM user_id_map;
  SELECT COUNT(*) INTO orphaned
  FROM profiles p
  LEFT JOIN auth.users au ON au.id = p.user_id
  WHERE au.id IS NULL;

  RAISE NOTICE '───── MAPPING RESULTS ─────';
  RAISE NOTICE 'Orphaned profiles: %', orphaned;
  RAISE NOTICE 'Auto-mapped:       %', mapped;
  IF orphaned > mapped THEN
    RAISE NOTICE '⚠ % profiles NOT mapped! Add manual mappings.', orphaned - mapped;
  END IF;
  IF mapped = 0 AND orphaned = 0 THEN
    RAISE NOTICE '✅ No orphans — UUIDs already match. Only fixing dates.';
  END IF;
END $$;

-- ── 2. Handle UNIQUE-constraint tables FIRST ─────────────
-- These tables have UNIQUE(user_id), so we must delete
-- the newer trigger-created rows before remapping old ones.

-- 2a. profiles — delete trigger-created duplicates
--     (new profiles created by handle_new_user trigger
--      when auth users logged in)
DELETE FROM profiles
WHERE user_id IN (SELECT new_user_id FROM user_id_map)
  AND user_id NOT IN (SELECT old_user_id FROM user_id_map);

-- 2b. user_credits — delete empty new rows
DELETE FROM user_credits
WHERE user_id IN (SELECT new_user_id FROM user_id_map)
  AND user_id NOT IN (SELECT old_user_id FROM user_id_map);

-- 2c. user_api_keys — delete empty new rows
DELETE FROM user_api_keys
WHERE user_id IN (SELECT new_user_id FROM user_id_map)
  AND user_id NOT IN (SELECT old_user_id FROM user_id_map);

-- 2d. user_roles — delete duplicate roles
DELETE FROM user_roles
WHERE user_id IN (SELECT new_user_id FROM user_id_map)
  AND user_id NOT IN (SELECT old_user_id FROM user_id_map);

-- ── 3. Remap user_id in ALL tables ───────────────────────

-- profiles
UPDATE profiles SET user_id = m.new_user_id
FROM user_id_map m WHERE profiles.user_id = m.old_user_id;

-- projects
UPDATE projects SET user_id = m.new_user_id
FROM user_id_map m WHERE projects.user_id = m.old_user_id;

-- generations
UPDATE generations SET user_id = m.new_user_id
FROM user_id_map m WHERE generations.user_id = m.old_user_id;

-- generation_archives
UPDATE generation_archives SET user_id = m.new_user_id
FROM user_id_map m WHERE generation_archives.user_id = m.old_user_id;

-- generation_costs
UPDATE generation_costs SET user_id = m.new_user_id
FROM user_id_map m WHERE generation_costs.user_id = m.old_user_id;

-- subscriptions
UPDATE subscriptions SET user_id = m.new_user_id
FROM user_id_map m WHERE subscriptions.user_id = m.old_user_id;

-- user_credits
UPDATE user_credits SET user_id = m.new_user_id
FROM user_id_map m WHERE user_credits.user_id = m.old_user_id;

-- credit_transactions
UPDATE credit_transactions SET user_id = m.new_user_id
FROM user_id_map m WHERE credit_transactions.user_id = m.old_user_id;

-- api_call_logs
UPDATE api_call_logs SET user_id = m.new_user_id
FROM user_id_map m WHERE api_call_logs.user_id = m.old_user_id;

-- system_logs
UPDATE system_logs SET user_id = m.new_user_id
FROM user_id_map m WHERE system_logs.user_id = m.old_user_id;

-- project_characters
UPDATE project_characters SET user_id = m.new_user_id
FROM user_id_map m WHERE project_characters.user_id = m.old_user_id;

-- project_shares
UPDATE project_shares SET user_id = m.new_user_id
FROM user_id_map m WHERE project_shares.user_id = m.old_user_id;

-- user_api_keys
UPDATE user_api_keys SET user_id = m.new_user_id
FROM user_id_map m WHERE user_api_keys.user_id = m.old_user_id;

-- user_voices
UPDATE user_voices SET user_id = m.new_user_id
FROM user_id_map m WHERE user_voices.user_id = m.old_user_id;

-- user_roles
UPDATE user_roles SET user_id = m.new_user_id
FROM user_id_map m WHERE user_roles.user_id = m.old_user_id;

-- user_flags (user_id + flagged_by + resolved_by)
UPDATE user_flags SET user_id = m.new_user_id
FROM user_id_map m WHERE user_flags.user_id = m.old_user_id;

UPDATE user_flags SET flagged_by = m.new_user_id
FROM user_id_map m WHERE user_flags.flagged_by = m.old_user_id;

UPDATE user_flags SET resolved_by = m.new_user_id
FROM user_id_map m WHERE user_flags.resolved_by = m.old_user_id;

-- video_generation_jobs
UPDATE video_generation_jobs SET user_id = m.new_user_id
FROM user_id_map m WHERE video_generation_jobs.user_id = m.old_user_id;

-- admin_logs (admin_id)
UPDATE admin_logs SET admin_id = m.new_user_id
FROM user_id_map m WHERE admin_logs.admin_id = m.old_user_id;

-- ── 4. Fix profiles.created_at ──────────────────────────
-- If auth.users preserved original created_at and it's
-- older than the profile date, sync it back.
UPDATE profiles p
SET created_at = au.created_at,
    updated_at = au.created_at
FROM auth.users au
WHERE p.user_id = au.id
  AND au.created_at < p.created_at;

-- ── 5. Ensure every auth user has exactly one profile ────
-- Create missing profiles for auth users that have none
INSERT INTO profiles (user_id, display_name, created_at, updated_at)
SELECT
  au.id,
  COALESCE(
    substring(au.raw_user_meta_data->>'full_name' FROM 1 FOR 100),
    split_part(au.email, '@', 1)
  ),
  au.created_at,
  au.created_at
FROM auth.users au
LEFT JOIN profiles p ON p.user_id = au.id
WHERE p.id IS NULL;

-- ── 6. Re-enable FK triggers ─────────────────────────────
SET session_replication_role = DEFAULT;

-- ── 7. Final verification ────────────────────────────────
DO $$
DECLARE
  o_profiles  INT; o_projects  INT; o_subs   INT;
  o_gens      INT; o_credits   INT; o_roles  INT;
  t_profiles  INT; t_auth      INT; t_projects INT;
BEGIN
  SELECT COUNT(*) INTO o_profiles
  FROM profiles p LEFT JOIN auth.users au ON au.id = p.user_id
  WHERE au.id IS NULL;

  SELECT COUNT(*) INTO o_projects
  FROM projects p LEFT JOIN auth.users au ON au.id = p.user_id
  WHERE au.id IS NULL;

  SELECT COUNT(*) INTO o_subs
  FROM subscriptions s LEFT JOIN auth.users au ON au.id = s.user_id
  WHERE au.id IS NULL;

  SELECT COUNT(*) INTO o_gens
  FROM generations g LEFT JOIN auth.users au ON au.id = g.user_id
  WHERE au.id IS NULL;

  SELECT COUNT(*) INTO o_credits
  FROM user_credits c LEFT JOIN auth.users au ON au.id = c.user_id
  WHERE au.id IS NULL;

  SELECT COUNT(*) INTO o_roles
  FROM user_roles r LEFT JOIN auth.users au ON au.id = r.user_id
  WHERE au.id IS NULL;

  SELECT COUNT(*) INTO t_profiles FROM profiles;
  SELECT COUNT(*) INTO t_auth FROM auth.users;
  SELECT COUNT(*) INTO t_projects FROM projects;

  RAISE NOTICE '';
  RAISE NOTICE '═══════ POST-FIX VERIFICATION ═══════';
  RAISE NOTICE 'Auth users:            %', t_auth;
  RAISE NOTICE 'Profiles:              %', t_profiles;
  RAISE NOTICE 'Projects (total):      %', t_projects;
  RAISE NOTICE '';
  RAISE NOTICE 'Orphaned profiles:     %', o_profiles;
  RAISE NOTICE 'Orphaned projects:     %', o_projects;
  RAISE NOTICE 'Orphaned subscriptions:%', o_subs;
  RAISE NOTICE 'Orphaned generations:  %', o_gens;
  RAISE NOTICE 'Orphaned credits:      %', o_credits;
  RAISE NOTICE 'Orphaned roles:        %', o_roles;

  IF o_profiles = 0 AND o_projects = 0 AND o_subs = 0
     AND o_gens = 0 AND o_credits = 0 AND o_roles = 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE '✅ ALL DATA CONNECTED — migration fix complete!';
  ELSE
    RAISE NOTICE '';
    RAISE NOTICE '⚠ Some data still orphaned — add manual mappings.';
  END IF;
END $$;

COMMIT;
