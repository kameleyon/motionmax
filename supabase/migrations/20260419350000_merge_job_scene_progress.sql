-- Atomic JSONB merge for scene progress — avoids the read-modify-write race
-- in flushSceneProgress(). Uses the || operator so the UPDATE never reads
-- the existing payload; only the sceneProgress key is touched.
CREATE OR REPLACE FUNCTION public.merge_job_scene_progress(
  p_job_id  uuid,
  p_progress jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.video_generation_jobs
  SET
    payload    = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('sceneProgress', p_progress),
    updated_at = now()
  WHERE id = p_job_id;
$$;
