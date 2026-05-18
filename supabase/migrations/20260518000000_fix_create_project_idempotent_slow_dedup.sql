-- Fix create_project_idempotent slow-soft-dedup that scanned full TOAST'd
-- content per row on every save attempt. With 248+ projects per user and
-- some content fields at 700+ kB each, the per-row content equality
-- detoast pushed the function past the 8s statement_timeout on the
-- authenticated role, surfacing as "Couldn't save project: canceling
-- statement due to statement timeout" on every save attempt.
--
-- Two changes:
--
--   1. Drop `content = v_content` from the soft-dedup WHERE clause. The
--      idempotency_key is the strong dedup (covered by the existing
--      projects_idempotency_key_unique partial index). The 5-second-
--      window match is a belt-and-suspenders defense against a client
--      that somehow lost its idempotency_key mid-submit — matching on
--      (user_id, title, project_type, created_at > 5s) is more than
--      enough. The probability of two LEGITIMATELY different projects
--      sharing the same title + project_type within a 5-second window
--      is effectively zero, and the React intake form generates a fresh
--      idempotency_key per submit anyway.
--
--   2. Add (user_id, created_at DESC) index so the soft-dedup time-
--      window predicate is satisfied by an index range scan instead of
--      a sequential scan over all the user's projects. Without this,
--      the planner had to read every row to evaluate `created_at > 5s`.

CREATE INDEX IF NOT EXISTS idx_projects_user_created
  ON public.projects (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.create_project_idempotent(
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_existing_id UUID;
  v_new_id UUID;
  v_title TEXT;
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

  -- 2. Soft dedup: same (title, project_type) within 5s. We deliberately
  --    do NOT match on `content` here — that forced a TOAST detoast per
  --    candidate row and broke the 8s statement_timeout for users with
  --    many large-content projects.
  v_title := p_payload->>'title';
  v_project_type := p_payload->>'project_type';

  IF v_title IS NOT NULL THEN
    SELECT id INTO v_existing_id
      FROM public.projects
     WHERE user_id = v_user_id
       AND title = v_title
       AND project_type = v_project_type
       AND created_at > NOW() - INTERVAL '5 seconds'
     ORDER BY created_at DESC
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  -- 3. Fresh insert.
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
    p_payload->>'content',
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
$function$;

COMMENT ON FUNCTION public.create_project_idempotent(text, jsonb) IS
  'Creates a project with idempotency. Soft-dedup intentionally does NOT
   match on `content` to avoid TOAST detoast-per-row that broke the 8s
   statement_timeout on heavy users. Strong dedup via the unique
   (user_id, idempotency_key) partial index covers the real
   double-submit case; soft dedup is the 5-second-window safety net.';
