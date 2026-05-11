-- update_scene_field_json: convert SQL NULL → JSON null before jsonb_set.
--
-- Bug: when a worker clears a per-scene field (e.g. videoUrl on
-- regenerate_image after the source image changed), the JS client
-- sends `null` as `p_value`. PostgREST binds that as SQL NULL on the
-- JSONB parameter, and `jsonb_set(jsonb, path, NULL)` returns SQL NULL
-- — which would set the entire `scenes` column to NULL. The defensive
-- trigger on `generations` then raises "Refusing to blank
-- generations.scenes for <id>: had N scenes, write would set to
-- empty/null", and the worker fell back to the racy read-modify-write
-- path (logged as errors and re-introducing the very race this RPC
-- was meant to eliminate).
--
-- Fix: COALESCE p_value to JSON null before handing it to jsonb_set
-- so the per-field value becomes JSON null (not SQL NULL) and the
-- surrounding `scenes` document stays intact.

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
    COALESCE(p_value, 'null'::jsonb)
  )
  WHERE id = p_generation_id;
END;
$$;

REVOKE ALL ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION update_scene_field_json(UUID, INT, TEXT, JSONB) TO service_role;
