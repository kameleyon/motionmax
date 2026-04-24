-- update_scene_field_json previously hard-failed for any caller where
-- auth.uid() IS NULL (which is every service_role/worker caller). That
-- made the worker's atomic JSON scene-field updates silently fall back
-- to the racy read-modify-write path — exactly the race the RPC was
-- supposed to eliminate. Mirror update_scene_field's pattern: only
-- enforce ownership when there IS a JWT; service_role (trusted server)
-- bypasses the check.

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
DECLARE
  caller_id UUID;
  gen_user_id UUID;
BEGIN
  caller_id := auth.uid();

  IF caller_id IS NOT NULL THEN
    SELECT user_id INTO gen_user_id
    FROM generations
    WHERE id = p_generation_id;

    IF gen_user_id IS NULL OR gen_user_id != caller_id THEN
      RAISE EXCEPTION 'Access denied: you do not own this generation';
    END IF;
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

REVOKE ALL ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) TO service_role;
