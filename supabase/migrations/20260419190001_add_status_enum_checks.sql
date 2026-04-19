-- Enforce valid status/type values on core tables.
-- Silent typos in these columns corrupt cleanup queries and worker logic.

-- Normalize any legacy/unexpected project_type values before constraining.
UPDATE public.projects
  SET project_type = 'doc2video'
  WHERE project_type NOT IN ('doc2video', 'smartflow', 'smart-flow', 'cinematic');

-- Normalize any legacy/unexpected status values before constraining.
UPDATE public.projects
  SET status = 'error'
  WHERE status NOT IN ('draft', 'generating', 'complete', 'error', 'delete');

ALTER TABLE public.projects
  ADD CONSTRAINT chk_projects_status
    CHECK (status IN ('draft', 'generating', 'complete', 'error', 'delete')),
  ADD CONSTRAINT chk_projects_project_type
    CHECK (project_type IN ('doc2video', 'smartflow', 'smart-flow', 'cinematic'));

ALTER TABLE public.generations
  ADD CONSTRAINT chk_generations_status
    CHECK (status IN ('pending', 'processing', 'complete', 'error'));

ALTER TABLE public.video_generation_jobs
  ADD CONSTRAINT chk_video_generation_jobs_status
    CHECK (status IN ('pending', 'processing', 'completed', 'failed'));
