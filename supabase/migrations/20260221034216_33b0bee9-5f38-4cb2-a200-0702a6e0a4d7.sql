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
BEGIN
  -- Lock the row to prevent race conditions from rapid clicking
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