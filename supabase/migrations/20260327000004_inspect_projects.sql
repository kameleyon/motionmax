-- Diagnostic query to understand current project states
-- Run this to see what projects exist and their characteristics

-- Summary by status
SELECT
  status,
  COUNT(*) as project_count
FROM projects
GROUP BY status
ORDER BY project_count DESC;

-- Projects with their generation counts
SELECT
  p.id,
  p.title,
  p.status,
  p.created_at,
  p.updated_at,
  p.user_id,
  COUNT(g.id) as generation_count,
  CASE
    WHEN COUNT(g.id) = 0 THEN 'No generations'
    ELSE 'Has generations'
  END as has_work
FROM projects p
LEFT JOIN generations g ON g.project_id = p.id
GROUP BY p.id, p.title, p.status, p.created_at, p.updated_at, p.user_id
ORDER BY p.created_at DESC
LIMIT 50;

-- Count of projects that SHOULD be deleted (draft + no generations)
SELECT
  COUNT(*) as projects_to_delete
FROM projects p
WHERE p.status = 'draft'
  AND NOT EXISTS (
    SELECT 1 FROM generations g WHERE g.project_id = p.id
  );
