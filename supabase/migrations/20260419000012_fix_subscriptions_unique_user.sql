-- Fix: enforce one subscription row per user_id to prevent duplicate rows from
-- webhook race conditions (e.g. two concurrent Stripe checkout.session.completed
-- events for the same user each inserting a new subscription row).
-- Uses a DO block because ALTER TABLE … ADD CONSTRAINT has no IF NOT EXISTS clause.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_user_id_unique'
      AND conrelid = 'public.subscriptions'::regclass
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_user_id_unique UNIQUE (user_id);
  END IF;
END;
$$;
