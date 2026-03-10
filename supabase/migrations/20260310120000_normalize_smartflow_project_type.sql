-- Normalize project_type: 'smart-flow' → 'smartflow'
-- The frontend uses 'smartflow' (single word). Any legacy rows stored as
-- 'smart-flow' (hyphenated) are normalized here so UI checks no longer need
-- the dual-value guard.
UPDATE public.projects
SET project_type = 'smartflow'
WHERE project_type = 'smart-flow';
