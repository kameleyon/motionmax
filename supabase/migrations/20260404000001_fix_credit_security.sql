-- FIX: deduct_credits_securely() - add auth check so users can only deduct their own credits
-- Previously any authenticated user could drain any other user's credits

CREATE OR REPLACE FUNCTION public.deduct_credits_securely(
  p_user_id UUID,
  p_amount INT,
  p_transaction_type TEXT,
  p_description TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  current_balance INT;
  caller_id UUID;
BEGIN
  -- Get the calling user's ID
  caller_id := auth.uid();

  -- Allow service_role to deduct for any user (worker calls)
  -- But authenticated users can ONLY deduct their own credits
  IF caller_id IS NOT NULL AND caller_id != p_user_id THEN
    RAISE EXCEPTION 'unauthorized: cannot deduct credits for another user';
  END IF;

  -- Lock the row to prevent race conditions
  SELECT credits_balance INTO current_balance
  FROM user_credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Check if enough credits
  IF current_balance IS NULL OR current_balance < p_amount THEN
    RETURN FALSE;
  END IF;

  -- Deduct credits
  UPDATE user_credits
  SET credits_balance = credits_balance - p_amount,
      total_used = total_used + p_amount,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  -- Insert receipt atomically
  INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
  VALUES (p_user_id, -p_amount, p_transaction_type, p_description);

  RETURN TRUE;
END;
$$;

-- FIX: update_scene_field() - revoke from anon, add auth check, set search_path
-- Previously any anonymous user could modify any generation's scenes

-- Drop the old function and recreate with auth check
DROP FUNCTION IF EXISTS public.update_scene_field(UUID, INT, TEXT, TEXT);

CREATE FUNCTION public.update_scene_field(
  p_generation_id UUID,
  p_scene_index INT,
  p_field TEXT,
  p_value TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  gen_user_id UUID;
  caller_id UUID;
BEGIN
  caller_id := auth.uid();

  IF caller_id IS NOT NULL THEN
    SELECT p.user_id INTO gen_user_id
    FROM generations g
    JOIN projects p ON p.id = g.project_id
    WHERE g.id = p_generation_id;

    IF gen_user_id IS NULL OR gen_user_id != caller_id THEN
      RAISE EXCEPTION 'unauthorized: generation does not belong to user';
    END IF;
  END IF;

  UPDATE generations
  SET scenes = jsonb_set(
    scenes::jsonb,
    ARRAY[p_scene_index::text, p_field],
    to_jsonb(p_value)
  )
  WHERE id = p_generation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_scene_field(UUID, INT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_scene_field(UUID, INT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_scene_field(UUID, INT, TEXT, TEXT) TO service_role;

-- FIX: refund_credits_securely() - add search_path
CREATE OR REPLACE FUNCTION public.refund_credits_securely(
  p_user_id UUID,
  p_amount INT,
  p_description TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  current_balance INT;
BEGIN
  SELECT credits_balance INTO current_balance
  FROM user_credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF current_balance IS NULL THEN
    INSERT INTO user_credits (user_id, credits_balance, total_purchased, total_used)
    VALUES (p_user_id, p_amount, 0, 0)
    ON CONFLICT (user_id) DO UPDATE
    SET credits_balance = user_credits.credits_balance + p_amount,
        total_used = GREATEST(0, user_credits.total_used - p_amount),
        updated_at = NOW();
  ELSE
    UPDATE user_credits
    SET credits_balance = credits_balance + p_amount,
        total_used = GREATEST(0, total_used - p_amount),
        updated_at = NOW()
    WHERE user_id = p_user_id;
  END IF;

  INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
  VALUES (p_user_id, p_amount, 'refund', p_description);

  RETURN TRUE;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Failed to refund credits for user %: %', p_user_id, SQLERRM;
    RETURN FALSE;
END;
$$;
