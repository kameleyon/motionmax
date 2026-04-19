-- Add a unique constraint on stripe_customer_id to complement the existing
-- UNIQUE(user_id) constraint.  Together they enforce the invariant that each
-- Motionmax user maps to exactly one Stripe customer AND each Stripe customer
-- maps to exactly one Motionmax user — preventing cross-account contamination
-- from webhook races (e.g. two concurrent checkout.session.completed events for
-- the same Stripe customer arriving for different user_ids).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_stripe_customer_id_unique'
      AND conrelid = 'public.subscriptions'::regclass
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_stripe_customer_id_unique UNIQUE (stripe_customer_id);
  END IF;
END;
$$;
