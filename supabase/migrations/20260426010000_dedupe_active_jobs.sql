-- Migration: dedupe in-flight video_generation_jobs at the DB level.
--
-- Problem (Forge / Prism audit, Theme — useSceneRegen race conditions):
--
-- `useSceneRegen.regenerateAudio` checks `isMasterAudioInFlight` BEFORE
-- inserting a new master_audio job. Two tabs hitting the Regenerate
-- button within the same ~200 ms window both pass that client-side
-- check (each reads its own snapshot) and queue duplicate
-- master_audio jobs. The worker then wastes credits doing the same
-- work twice and the second result overwrites the first.
--
-- A lone client-side guard cannot be made sound — only a DB-level
-- exclusion can. This partial unique index enforces "at most one
-- non-terminal job per (project_id, task_type) for project-scoped
-- task types". Per-scene tasks (regenerate_image, regenerate_audio,
-- cinematic_image, cinematic_video, cinematic_audio) include the
-- scene_index to allow concurrent per-scene regens.
--
-- Inserts that would collide will fail with a unique-violation error,
-- which the client should handle as "another tab/user already started
-- this job" rather than retrying.

-- Project-scoped tasks: master_audio, export_video. Only one of each
-- can be in-flight per project at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_video_jobs_project_task_active
  ON public.video_generation_jobs (project_id, task_type)
  WHERE status IN ('pending', 'processing')
    AND task_type IN ('master_audio', 'export_video');

-- Per-scene tasks: scene_index lives in payload. We index on
-- (project_id, task_type, payload->>'sceneIndex') so two regens
-- targeting the same scene get blocked, but different scenes don't.
CREATE UNIQUE INDEX IF NOT EXISTS uq_video_jobs_project_task_scene_active
  ON public.video_generation_jobs (
    project_id,
    task_type,
    (payload->>'sceneIndex')
  )
  WHERE status IN ('pending', 'processing')
    AND task_type IN (
      'regenerate_image',
      'regenerate_audio',
      'cinematic_image',
      'cinematic_video',
      'cinematic_audio'
    )
    AND payload->>'sceneIndex' IS NOT NULL;

COMMENT ON INDEX public.uq_video_jobs_project_task_active IS
  'Prevents duplicate in-flight project-scoped jobs (master_audio, export_video) when two tabs/users race the Regenerate button. Insert fails with unique_violation; client surfaces "already in flight".';

COMMENT ON INDEX public.uq_video_jobs_project_task_scene_active IS
  'Prevents duplicate in-flight per-scene jobs (image/audio/video regens) targeting the same scene. Different scenes are unaffected.';
