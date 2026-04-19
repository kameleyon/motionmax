-- Add explicit boolean column for manual enterprise subscriptions.
-- The startsWith("manual_") string sentinel in application code is user-controllable
-- if any code path ever passes user input to stripe_subscription_id. A dedicated
-- column enforced at the DB level is authoritative and cannot be gamed via string prefix.

ALTER TABLE public.subscriptions
  ADD COLUMN is_manual_subscription BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill rows that already use the manual_ convention
UPDATE public.subscriptions
  SET is_manual_subscription = TRUE
  WHERE stripe_subscription_id LIKE 'manual_%';

-- Constrain stripe_subscription_id to valid Stripe or manual_ formats (defense-in-depth)
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_stripe_sub_id_format
  CHECK (
    stripe_subscription_id IS NULL
    OR stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'
    OR stripe_subscription_id ~ '^manual_[A-Za-z0-9_-]+$'
  );
