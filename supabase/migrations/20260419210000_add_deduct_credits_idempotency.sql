-- Add idempotency_key to credit_transactions to prevent double-charges on retried generation calls.
-- The column is nullable: transactions without a key remain unrestricted.
ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial unique index ensures each idempotency key can only be used once per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_transactions_idempotency_key
  ON public.credit_transactions (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Rewrite deduct_credits_securely with optional idempotency_key parameter.
-- When a key is supplied: if a matching transaction already exists the function
-- returns TRUE immediately without re-deducting (safe retry).
CREATE OR REPLACE FUNCTION public.deduct_credits_securely(
  p_user_id         UUID,
  p_amount          INT,
  p_transaction_type TEXT,
  p_description     TEXT,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  bal INT;
BEGIN
  -- Auth guard: callers may only deduct their own credits.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Idempotency: if this key was already processed, short-circuit.
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM credit_transactions
    WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN TRUE;
    END IF;
  END IF;

  SELECT credits_balance INTO bal
  FROM user_credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF bal IS NULL OR bal < p_amount THEN
    RETURN FALSE;
  END IF;

  UPDATE user_credits
  SET credits_balance = credits_balance - p_amount,
      total_used      = total_used + p_amount,
      updated_at      = NOW()
  WHERE user_id = p_user_id;

  INSERT INTO credit_transactions (user_id, amount, transaction_type, description, idempotency_key)
  VALUES (p_user_id, -p_amount, p_transaction_type, p_description, p_idempotency_key);

  RETURN TRUE;
END;
$$;
