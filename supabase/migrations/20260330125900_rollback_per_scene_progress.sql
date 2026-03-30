-- Rollback: Remove per-scene progress tracking columns added in 20260329000004
-- Drop the index first
DROP INDEX IF EXISTS idx_jobs_scene_progress;

-- Drop the columns
ALTER TABLE public.video_generation_jobs
DROP COLUMN IF EXISTS current_scene,
DROP COLUMN IF EXISTS total_scenes,
DROP COLUMN IF EXISTS scene_progress;
