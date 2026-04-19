-- Fix: prevent negative credits_balance in user_credits
-- Race conditions in concurrent deduction paths could silently drive the balance
-- below zero without this guard. Uses a DO block because ALTER TABLE … ADD CONSTRAINT
-- has no IF NOT EXISTS clause in PostgreSQL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_credits_balance_non_negative'
      AND conrelid = 'public.user_credits'::regclass
  ) THEN
    ALTER TABLE public.user_credits
      ADD CONSTRAINT user_credits_balance_non_negative
      CHECK (credits_balance >= 0);
  END IF;
END;
$$;
