-- Fix: enforce one subscription row per user_id
ALTER TABLE public.subscriptions
  ADD CONSTRAINT IF NOT EXISTS subscriptions_user_id_unique UNIQUE (user_id);
