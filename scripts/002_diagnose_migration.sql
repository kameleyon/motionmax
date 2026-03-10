-- ============================================================
-- 002_diagnose_migration.sql
-- Run this FIRST in the Supabase SQL Editor to understand
-- the current state of the auth→data linkage.
-- ============================================================

-- 1. Show all current auth.users (new UUIDs after migration)
SELECT '=== CURRENT AUTH USERS ===' AS section;
SELECT id AS auth_user_id, email, created_at AS auth_created_at
FROM auth.users
ORDER BY created_at;

-- 2. Show all profiles and whether their user_id has a matching auth.users entry
SELECT '=== PROFILES — ORPHAN CHECK ===' AS section;
SELECT
  p.id          AS profile_id,
  p.user_id     AS profile_user_id,
  p.display_name,
  au.id IS NOT NULL AS has_auth_user,
  au.email       AS auth_email,
  p.created_at   AS profile_created_at
FROM profiles p
LEFT JOIN auth.users au ON au.id = p.user_id
ORDER BY p.created_at;

-- 3. Auth users that do NOT have a profile (trigger-created or missing)
SELECT '=== AUTH USERS WITHOUT PROFILES ===' AS section;
SELECT au.id AS auth_user_id, au.email, au.created_at
FROM auth.users au
LEFT JOIN profiles p ON p.user_id = au.id
WHERE p.id IS NULL;

-- 4. Count orphaned rows per table (user_id NOT in auth.users)
SELECT '=== ORPHANED ROW COUNTS ===' AS section;
SELECT 'projects' AS table_name,
       COUNT(*) AS orphaned_rows
FROM projects WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'generations',
       COUNT(*)
FROM generations WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'subscriptions',
       COUNT(*)
FROM subscriptions WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'user_credits',
       COUNT(*)
FROM user_credits WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'user_roles',
       COUNT(*)
FROM user_roles WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'user_voices',
       COUNT(*)
FROM user_voices WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'user_api_keys',
       COUNT(*)
FROM user_api_keys WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'credit_transactions',
       COUNT(*)
FROM credit_transactions WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'generation_costs',
       COUNT(*)
FROM generation_costs WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'api_call_logs',
       COUNT(*)
FROM api_call_logs WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'system_logs',
       COUNT(*)
FROM system_logs WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'project_characters',
       COUNT(*)
FROM project_characters WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'project_shares',
       COUNT(*)
FROM project_shares WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'user_flags',
       COUNT(*)
FROM user_flags WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'video_generation_jobs',
       COUNT(*)
FROM video_generation_jobs WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'generation_archives',
       COUNT(*)
FROM generation_archives WHERE user_id NOT IN (SELECT id FROM auth.users)
UNION ALL
SELECT 'admin_logs',
       COUNT(*)
FROM admin_logs WHERE admin_id NOT IN (SELECT id FROM auth.users);

-- 5. Proposed auto-mapping: old orphaned profiles ↔ new auth users by display_name
SELECT '=== PROPOSED AUTO-MAPPING ===' AS section;
SELECT
  old_p.user_id   AS old_user_id,
  old_p.display_name AS old_display_name,
  au.id            AS new_user_id,
  au.email         AS new_email,
  COALESCE(
    au.raw_user_meta_data->>'full_name',
    split_part(au.email, '@', 1)
  ) AS auth_derived_name
FROM profiles old_p
LEFT JOIN auth.users au_check ON au_check.id = old_p.user_id
-- Only orphaned old profiles
CROSS JOIN auth.users au
WHERE au_check.id IS NULL
  AND (
    -- Match by display_name ≈ email prefix (case insensitive)
    lower(old_p.display_name) = lower(split_part(au.email, '@', 1))
    OR lower(old_p.display_name) = lower(COALESCE(au.raw_user_meta_data->>'full_name', ''))
  )
ORDER BY old_p.display_name;
