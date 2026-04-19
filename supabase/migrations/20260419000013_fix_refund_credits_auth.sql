-- Fix: add auth.uid() guard to refund_credits_securely (defense-in-depth)
-- Only authenticated callers should be able to invoke this function.

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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Lock the row to prevent race conditions
  SELECT credits_balance INTO current_balance
  FROM user_credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- If user doesn't exist in user_credits, create entry
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

GRANT EXECUTE ON FUNCTION public.refund_credits_securely(UUID, INT, TEXT) TO service_role;
