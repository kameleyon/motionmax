-- ============================================================
-- C-7-12 / Ghost G-C1+G-C2: project idempotency key
-- ============================================================
--
-- WHY:
--   IntakeForm.handleGenerate + useExport.startExport had NO
--   synchronous lock against Enter-mash / two-tab submission. Each
--   click inserted a new projects row AND deducted credits, so a
--   double-fire = duplicate project + double credit charge. Real
--   money lost on every accidental double-Enter.
--
--   We add a client-generated idempotency key (UUID, generated once
--   per logical submit). The frontend's React-level lock is the fast
--   path; this column + the create_project_idempotent RPC are the
--   server-side belt-and-suspenders. A retry inside the dedup window
--   returns the EXISTING project id instead of creating a duplicate.
--
-- BACKFILL:
--   Column is NULLABLE on purpose. Legacy rows have NULL and the
--   UNIQUE index uses WHERE idempotency_key IS NOT NULL so they
--   don't collide. New writes from updated clients always send a
--   key.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial unique index — only enforced on rows that have a key.
-- Legacy rows with NULL coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS projects_idempotency_key_unique
  ON public.projects(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- create_project_idempotent(p_idempotency_key, p_payload jsonb)
-- ============================================================
-- Inserts into projects with ON CONFLICT DO NOTHING semantics
-- (via the partial unique index above). If a row with the same
-- (user_id, idempotency_key) already exists, returns that row's id
-- instead of creating a new one. The caller can treat the result
-- as "the project id for this logical submit" regardless of how
-- many times they retried.
--
-- We also enforce a SHORT-WINDOW dedup against bare duplicate
-- submits (user with two tabs, no idempotency key in client cache).
-- If the same user inserted ANY project in the last 5 seconds with
-- identical title + content + project_type, we return that row's
-- id. This is the safety net for clients that haven't been updated
-- to send keys yet.
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

  -- The payload's user_id MUST match the caller. Defensive — RLS would
  -- catch this anyway since the INSERT happens in this body, but if
  -- the client passed someone else's user_id we want a hard error
  -- before we even touch the table.
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
  --    Catches Enter-mash from clients that didn't generate a key.
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

  -- 3. Fresh insert. Build the row dynamically from the JSON payload so
  --    the caller controls every column. We pin user_id + the key
  --    server-side; everything else is from p_payload.
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
    CASE WHEN jsonb_typeof(p_payload->'character_images') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(p_payload->'character_images'))
         ELSE NULL END,
    COALESCE(p_payload->'intake_settings', '{}'::jsonb),
    NULLIF(p_idempotency_key, '')
  )
  ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_new_id;

  -- ON CONFLICT DO NOTHING can return NULL when the race lost. Re-read
  -- the canonical row's id so the caller always gets a usable uuid.
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
  'C-7-12: idempotent project insert. Returns existing project id when called twice with the same (user_id, idempotency_key) or within 5s with identical (title, content, project_type). Prevents duplicate project rows + double credit charges on Enter-mash / cross-tab submits.';
