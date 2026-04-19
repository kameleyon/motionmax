-- Standardize video_generation_jobs.project_id FK to ON DELETE CASCADE.
-- Migration 20260316214700 set the action to SET NULL. Migration 20260404000003
-- attempted to add CASCADE but its IF NOT EXISTS guard silently skipped it
-- because the SET NULL constraint already existed. Environments now have
-- inconsistent behaviour depending on which branch of migrations ran.
-- Jobs belong to a project and should be removed when the project is deleted.

ALTER TABLE public.video_generation_jobs
  DROP CONSTRAINT IF EXISTS video_generation_jobs_project_id_fkey;

ALTER TABLE public.video_generation_jobs
  ADD CONSTRAINT video_generation_jobs_project_id_fkey
    FOREIGN KEY (project_id)
    REFERENCES public.projects(id)
    ON DELETE CASCADE;
