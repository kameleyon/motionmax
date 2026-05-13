-- ============================================================
-- Fix: create_project_idempotent inserted character_images as text[]
-- ============================================================
--
-- Bug:
--   The 20260510240000_project_idempotency_key.sql migration introduced
--   create_project_idempotent. Inside its INSERT, character_images was
--   converted to a Postgres text[] via
--     ARRAY(SELECT jsonb_array_elements_text(p_payload->'character_images'))
--   but the projects.character_images column is jsonb (per the
--   20260411000001_character_images_array.sql migration). Postgres
--   rejected every save with:
--     column "character_images" is of type jsonb but expression is of
--     type text[]
--   which surfaced to the user as "Couldn't save project: ..." on
--   IntakeForm submit whenever any character reference images were
--   attached.
--
-- Fix:
--   Pass the JSONB sub-array straight through — it's already the
--   right type, no conversion needed. Everything else in the function
--   stays identical.

CREATE OR REPLACE FUNCTION public.create_project_idempotent(
  p_idempotency_key TEXT,
  p_payload JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_existing_id UUID;
  v_new_id UUID;
  v_title TEXT;
  v_content TEXT;
  v_project_type TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  IF p_payload->>'user_id' IS DISTINCT FROM v_user_id::TEXT THEN
    RAISE EXCEPTION 'user_id in payload must match caller';
  END IF;

  -- 1. Strong dedup: same idempotency key from same user → existing row.
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    SELECT id INTO v_existing_id
      FROM public.projects
     WHERE user_id = v_user_id
       AND idempotency_key = p_idempotency_key
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  -- 2. Soft dedup: same (title, content, project_type) within 5s.
  v_title := p_payload->>'title';
  v_content := p_payload->>'content';
  v_project_type := p_payload->>'project_type';

  IF v_title IS NOT NULL AND v_content IS NOT NULL THEN
    SELECT id INTO v_existing_id
      FROM public.projects
     WHERE user_id = v_user_id
       AND title = v_title
       AND content = v_content
       AND project_type = v_project_type
       AND created_at > NOW() - INTERVAL '5 seconds'
     ORDER BY created_at DESC
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  -- 3. Fresh insert. Build the row dynamically from the JSON payload.
  INSERT INTO public.projects (
    user_id,
    title,
    content,
    project_type,
    format,
    length,
    voice_name,
    voice_type,
    voice_id,
    voice_inclination,
    style,
    character_description,
    character_consistency_enabled,
    character_images,
    intake_settings,
    idempotency_key
  ) VALUES (
    v_user_id,
    v_title,
    v_content,
    v_project_type,
    p_payload->>'format',
    p_payload->>'length',
    p_payload->>'voice_name',
    p_payload->>'voice_type',
    p_payload->>'voice_id',
    p_payload->>'voice_inclination',
    p_payload->>'style',
    p_payload->>'character_description',
    COALESCE((p_payload->>'character_consistency_enabled')::BOOLEAN, false),
    -- THE FIX: pass the JSONB array straight through. Previous version
    -- converted via jsonb_array_elements_text → ARRAY which produced a
    -- text[] and failed the jsonb column cast.
    CASE WHEN jsonb_typeof(p_payload->'character_images') = 'array'
         THEN p_payload->'character_images'
         ELSE NULL::JSONB END,
    COALESCE(p_payload->'intake_settings', '{}'::jsonb),
    NULLIF(p_idempotency_key, '')
  )
  ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NULL THEN
    SELECT id INTO v_new_id
      FROM public.projects
     WHERE user_id = v_user_id
       AND idempotency_key = p_idempotency_key
     LIMIT 1;
  END IF;

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_project_idempotent(TEXT, JSONB) TO authenticated;
COMMENT ON FUNCTION public.create_project_idempotent IS
  'C-7-12: idempotent project insert. character_images bug fixed 2026-05-12 (was inserting as text[] instead of jsonb).';
