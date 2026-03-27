-- =====================================================
-- Fix generations foreign key to use CASCADE
-- =====================================================
-- The generations table should have ON DELETE CASCADE
-- so that deleting a project automatically deletes
-- its generations. This migration fixes the constraint.
-- =====================================================

-- Drop the old constraint
ALTER TABLE generations
DROP CONSTRAINT IF EXISTS generations_project_id_fkey;

-- Add the constraint back with CASCADE
ALTER TABLE generations
ADD CONSTRAINT generations_project_id_fkey
FOREIGN KEY (project_id)
REFERENCES projects(id)
ON DELETE CASCADE;

-- Verify the constraint is correct
SELECT
  tc.constraint_name,
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name,
  rc.delete_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
JOIN information_schema.referential_constraints AS rc
  ON rc.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name = 'generations'
  AND kcu.column_name = 'project_id';
