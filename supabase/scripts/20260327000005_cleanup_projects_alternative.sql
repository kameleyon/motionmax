-- =====================================================
-- Alternative Project Cleanup Options
-- =====================================================
-- Choose ONE of the options below based on your needs
-- Uncomment the one you want to use
-- =====================================================

-- OPTION 1: Delete ALL projects with no generations (regardless of status)
-- This removes any project that was never used to generate a video
/*
DELETE FROM projects
WHERE NOT EXISTS (
  SELECT 1 FROM generations WHERE generations.project_id = projects.id
);
*/

-- OPTION 2: Delete projects with empty or very short content
-- This removes projects where the content field is minimal
/*
DELETE FROM projects
WHERE LENGTH(COALESCE(content, '')) < 10;
*/

-- OPTION 3: Delete ALL projects (DANGEROUS - use with caution!)
-- Only use this if you want to completely wipe all projects
/*
DELETE FROM projects;
*/

-- OPTION 4: Delete old unused projects
-- Delete projects older than 30 days with no generations
/*
DELETE FROM projects
WHERE created_at < NOW() - INTERVAL '30 days'
  AND NOT EXISTS (
    SELECT 1 FROM generations WHERE generations.project_id = projects.id
  );
*/

-- OPTION 5: Delete specific user's projects with no generations
-- Replace 'USER_ID_HERE' with actual user ID
/*
DELETE FROM projects
WHERE user_id = 'USER_ID_HERE'
  AND NOT EXISTS (
    SELECT 1 FROM generations WHERE generations.project_id = projects.id
  );
*/

-- =====================================================
-- RECOMMENDED: Run this FIRST to see what would be deleted
-- =====================================================
SELECT
  p.id,
  p.title,
  p.status,
  p.user_id,
  p.created_at,
  LENGTH(p.content) as content_length,
  COUNT(g.id) as generation_count
FROM projects p
LEFT JOIN generations g ON g.project_id = p.id
GROUP BY p.id, p.title, p.status, p.user_id, p.created_at, p.content
ORDER BY p.created_at DESC;
