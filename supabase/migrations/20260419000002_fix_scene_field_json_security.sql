-- Fix SECURITY DEFINER exposure: revoke anon access and enforce ownership check inside function.

REVOKE EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) FROM authenticated;

CREATE OR REPLACE FUNCTION update_scene_field_json(
  p_generation_id UUID,
  p_scene_index   INT,
  p_field         TEXT,
  p_value         JSONB
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM generations WHERE id = p_generation_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Access denied: you do not own this generation';
  END IF;

  UPDATE generations
  SET scenes = jsonb_set(
    scenes::jsonb,
    ARRAY[p_scene_index::text, p_field],
    p_value
  )
  WHERE id = p_generation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) TO service_role;
