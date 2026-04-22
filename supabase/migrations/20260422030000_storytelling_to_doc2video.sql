-- One-shot data migration: the original "Storytelling" project type
-- was renamed to "doc2video" (labelled "Explainer" in the UI) a while
-- back, but pre-existing rows kept the old literal and fall through
-- the Explainer filter in the dashboard. This canonicalises every
-- storytelling project so the filter count matches reality.
--
-- Runs idempotently — re-applying the migration is a no-op because
-- there won't be any "storytelling" rows left to update.
UPDATE public.projects
SET project_type = 'doc2video'
WHERE lower(coalesce(project_type, '')) = 'storytelling';

-- Same for any other legacy label we occasionally saw on imported or
-- seed projects. Add more aliases here if we discover them later.
UPDATE public.projects
SET project_type = 'doc2video'
WHERE lower(coalesce(project_type, '')) = 'explainer'
  AND project_type <> 'doc2video';
