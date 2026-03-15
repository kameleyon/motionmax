-- Allow project_id to be NULL in video_generation_jobs
-- Script phase jobs don't have a project yet (worker creates it during processing)
ALTER TABLE public.video_generation_jobs ALTER COLUMN project_id DROP NOT NULL;
