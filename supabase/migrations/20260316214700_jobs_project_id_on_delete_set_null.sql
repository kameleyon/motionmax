-- Fix FK constraint so deleting a project nulls out job references instead of blocking.
-- project_id is already nullable (20260315164505_allow_null_project_id_jobs.sql),
-- so SET NULL is safe and prevents the 23503 violation on project deletion.

ALTER TABLE public.video_generation_jobs
  DROP CONSTRAINT IF EXISTS video_generation_jobs_project_id_fkey;

ALTER TABLE public.video_generation_jobs
  ADD CONSTRAINT video_generation_jobs_project_id_fkey
    FOREIGN KEY (project_id)
    REFERENCES public.projects(id)
    ON DELETE SET NULL;
