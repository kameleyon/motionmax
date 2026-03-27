-- =====================================================
-- Cleanup Failed and Stuck Projects
-- =====================================================
-- Deletes projects that are:
--   - status = 'generating' (stuck/abandoned)
--   - status = 'error' (failed)
--   - status = 'delete' (marked for deletion)
--
-- These are incomplete projects that never completed
-- successfully and are just cluttering the database.
-- =====================================================

-- PREVIEW: See what will be deleted (run this first!)
-- Uncomment to preview:
/*
SELECT
  p.id,
  p.title,
  p.status,
  p.user_id,
  p.created_at,
  p.updated_at,
  COUNT(g.id) as generation_count,
  MAX(g.status) as latest_generation_status
FROM projects p
LEFT JOIN generations g ON g.project_id = p.id
WHERE p.status IN ('generating', 'error', 'delete')
GROUP BY p.id, p.title, p.status, p.user_id, p.created_at, p.updated_at
ORDER BY p.created_at DESC;
*/

-- DELETE: Remove failed/stuck projects
WITH deleted AS (
  DELETE FROM projects
  WHERE status IN ('generating', 'error', 'delete')
  RETURNING id, title, status, user_id, created_at
)
SELECT
  COUNT(*) as total_deleted,
  COUNT(DISTINCT user_id) as affected_users,
  status,
  COUNT(*) as count_by_status
FROM deleted
GROUP BY status
ORDER BY count_by_status DESC;
