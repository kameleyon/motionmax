-- Fix: worker-side refunds silently fail because refund_credits_securely
-- rejects any caller where auth.uid() IS NULL. The worker connects with the
-- service_role key (auth.uid() = NULL), so every refund raises 'Not
-- authenticated' → caught by WHEN OTHERS → returns FALSE. Credits never
-- come back to the user.
--
-- Correct model (matches deduct_credits_securely from migration 20260404000001):
--   • service_role (auth.uid() IS NULL) may refund for any user
--   • authenticated users may only refund their own credits
--
-- Also preserves the existing EXCEPTION handler that converts runtime errors
-- into a FALSE return value, so callers can distinguish "unauthorized" (raised)
-- from "failed during execution" (returns FALSE).

CREATE OR REPLACE FUNCTION public.refund_credits_securely(
  p_user_id     UUID,
  p_amount      INT,
  p_description TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  current_balance INT;
  caller_id       UUID;
BEGIN
  caller_id := auth.uid();

  -- Authenticated users may only refund themselves. Service role (NULL
  -- caller_id) may refund for any user — the worker relies on this.
  IF caller_id IS NOT NULL AND caller_id <> p_user_id THEN
    RAISE EXCEPTION 'unauthorized: cannot refund credits for another user';
  END IF;

  SELECT credits_balance INTO current_balance
  FROM user_credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF current_balance IS NULL THEN
    INSERT INTO user_credits (user_id, credits_balance, total_purchased, total_used)
    VALUES (p_user_id, p_amount, 0, 0)
    ON CONFLICT (user_id) DO UPDATE
    SET credits_balance = user_credits.credits_balance + p_amount,
        total_used      = GREATEST(0, user_credits.total_used - p_amount),
        updated_at      = NOW();
  ELSE
    UPDATE user_credits
    SET credits_balance = credits_balance + p_amount,
        total_used      = GREATEST(0, total_used - p_amount),
        updated_at      = NOW()
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

GRANT EXECUTE ON FUNCTION public.refund_credits_securely(UUID, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_credits_securely(UUID, INT, TEXT) TO service_role;
