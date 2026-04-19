-- Fix: prevent negative credits_balance in user_credits
ALTER TABLE public.user_credits
  ADD CONSTRAINT IF NOT EXISTS user_credits_balance_non_negative
  CHECK (credits_balance >= 0);
