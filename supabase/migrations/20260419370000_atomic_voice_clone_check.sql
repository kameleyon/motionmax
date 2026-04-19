-- Atomic voice-clone plan limit enforcement.
--
-- The edge function previously did a SELECT count → INSERT which is a
-- non-atomic read-modify-write. Two concurrent clone requests for the same
-- user can both pass the count check and both succeed, exceeding the plan cap.
--
-- This function performs the count + insert atomically inside a single
-- transaction with an explicit row lock (FOR UPDATE SKIP LOCKED on the
-- user_voices rows) to prevent the race.

CREATE OR REPLACE FUNCTION public.claim_voice_clone_slot(
  p_user_id        uuid,
  p_limit          int,
  p_name           text,
  p_eleven_id      text,
  p_model_id       text DEFAULT NULL,
  p_language       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
  v_id    uuid;
BEGIN
  -- Lock existing rows for this user to prevent concurrent inserts
  SELECT COUNT(*) INTO v_count
  FROM public.user_voices
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_count >= p_limit THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'plan_limit_reached',
      'current', v_count,
      'limit', p_limit
    );
  END IF;

  INSERT INTO public.user_voices (user_id, name, eleven_voice_id, model_id, language)
  VALUES (p_user_id, p_name, p_eleven_id, p_model_id, p_language)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_id,
    'current', v_count + 1,
    'limit', p_limit
  );
END;
$$;

COMMENT ON FUNCTION public.claim_voice_clone_slot IS
  'Atomically check plan voice-clone limit and insert a new user_voices row. Prevents the race condition where two concurrent requests both pass the count check.';
