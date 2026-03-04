
CREATE OR REPLACE FUNCTION public.update_scene_at_index(
  p_generation_id uuid,
  p_scene_index integer,
  p_scene_data jsonb,
  p_progress integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE generations
  SET 
    scenes = jsonb_set(scenes, ARRAY[p_scene_index::text], p_scene_data),
    progress = COALESCE(p_progress, progress)
  WHERE id = p_generation_id;
END;
$$;
