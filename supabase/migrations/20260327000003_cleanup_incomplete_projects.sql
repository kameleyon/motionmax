-- =====================================================
-- Cleanup Incomplete Projects
-- =====================================================
-- Deletes projects that are:
--   1. In draft status (never completed)
--   2. AND have no associated generations (never used)
--
-- This is safe because it only removes projects that were
-- created but never actually used to generate videos.
-- =====================================================

-- PREVIEW MODE: Uncomment to see what will be deleted (run this first!)
-- SELECT
--   p.id,
--   p.title,
--   p.user_id,
--   p.created_at,
--   p.status,
--   COUNT(g.id) as generation_count
-- FROM projects p
-- LEFT JOIN generations g ON g.project_id = p.id
-- WHERE p.status = 'draft'
-- GROUP BY p.id, p.title, p.user_id, p.created_at, p.status
-- HAVING COUNT(g.id) = 0
-- ORDER BY p.created_at DESC;

-- EXECUTION: Delete incomplete draft projects with no generations
WITH deleted AS (
  DELETE FROM projects
  WHERE status = 'draft'
    AND NOT EXISTS (
      SELECT 1 FROM generations WHERE generations.project_id = projects.id
    )
  RETURNING id, title, user_id, created_at
)
SELECT
  COUNT(*) as total_deleted,
  COUNT(DISTINCT user_id) as affected_users,
  MIN(created_at) as oldest_project,
  MAX(created_at) as newest_project
FROM deleted;
