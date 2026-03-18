-- Atomic scene field update to prevent read-modify-write race conditions
-- when multiple concurrent worker jobs update different scenes in the same generation.
-- Instead of reading the full scenes array, modifying one element, and writing it all back,
-- this function uses jsonb_set to surgically update a single field in a single scene.

CREATE OR REPLACE FUNCTION update_scene_field(
  p_generation_id UUID,
  p_scene_index INT,
  p_field TEXT,
  p_value TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE generations
  SET scenes = jsonb_set(
    scenes::jsonb,
    ARRAY[p_scene_index::text, p_field],
    to_jsonb(p_value)
  )
  WHERE id = p_generation_id;
END;
$$;

-- Grant access so both anon (worker service-role) and authenticated users can call it
GRANT EXECUTE ON FUNCTION update_scene_field(UUID, INT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION update_scene_field(UUID, INT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION update_scene_field(UUID, INT, TEXT, TEXT) TO service_role;
