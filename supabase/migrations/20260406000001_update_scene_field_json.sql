-- Atomic scene field update that accepts a raw JSON value (array, object, etc.)
-- Companion to update_scene_field (which only handles text values).
-- Needed for fields like imageUrls that store JSON arrays.

CREATE OR REPLACE FUNCTION update_scene_field_json(
  p_generation_id UUID,
  p_scene_index INT,
  p_field TEXT,
  p_value JSONB
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
    p_value
  )
  WHERE id = p_generation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) TO anon;
GRANT EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) TO service_role;
