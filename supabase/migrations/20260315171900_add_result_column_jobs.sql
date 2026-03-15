-- Add `result` JSONB column to video_generation_jobs.
-- The worker writes the script result here so the frontend can poll it.
-- Previously the worker tried to UPDATE this column but it didn't exist,
-- causing silent failures.
ALTER TABLE public.video_generation_jobs
  ADD COLUMN IF NOT EXISTS result JSONB;
