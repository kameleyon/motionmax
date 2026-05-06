-- ============================================================
-- Billing & Plans page — Pack add-ons + subscription pause
-- ------------------------------------------------------------
-- WHAT: Adds tracking columns for the new "stacked pack" Stripe
--       subscription items (1x / 2x / 4x / 10x multiplier on the
--       base plan's monthly credit grant) and the pause feature.
--
-- WHY:  The Plans tab pack-multiplier dropdown writes into Stripe
--       via the update-pack-quantity edge fn; the webhook syncs
--       the resulting subscription_item id + quantity into our
--       DB. The Pause button writes paused_until.
--
-- IMPLEMENTS: Billing & Plans checklist sections A.2, A.3.
-- ============================================================

BEGIN;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS pack_quantity int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS pack_subscription_item_id text,
  ADD COLUMN IF NOT EXISTS paused_until timestamptz;

COMMENT ON COLUMN public.subscriptions.pack_quantity IS
  'Stripe Subscription Item quantity for the pack add-on (1, 2, 4, or 10). 1 = base plan only, no add-on. Synced from customer.subscription.updated webhook.';
COMMENT ON COLUMN public.subscriptions.pack_subscription_item_id IS
  'Stripe SubscriptionItem id for the pack add-on Price line. NULL when pack_quantity = 1. Set by stripe-webhook on subscription.updated.';
COMMENT ON COLUMN public.subscriptions.paused_until IS
  'When set, the subscription is paused (Stripe pause_collection) until this timestamp. The pause-subscription edge fn writes both Stripe + this column.';

CREATE INDEX IF NOT EXISTS idx_subscriptions_paused_until
  ON public.subscriptions(paused_until)
  WHERE paused_until IS NOT NULL;

COMMIT;
