-- ============================================================
-- C-7-13 / Ghost G-C3: stripe_processed_invoices idempotency table
-- ============================================================
--
-- WHY:
--   stripe-webhook's invoice.paid handler grants monthly subscription
--   credits but had no per-invoice idempotency. webhook_events keys
--   on stripe event_id, NOT on invoice_id. Stripe delivers webhooks
--   at-least-once and occasionally regenerates an event_id when
--   re-emitting from the dashboard. A user could get 2× monthly
--   credits if the same invoice produces two events.
--
--   This table is the second idempotency layer: keyed on the Stripe
--   invoice id itself. The handler INSERTs into it inside the same
--   logical step as the credit grant; the partial unique constraint
--   collapses any retry into a single grant.
--
-- AUDIT TRAIL:
--   amount_paid + customer_id + plan_name + credits_granted are
--   recorded so finance can reconcile against Stripe at any time.

CREATE TABLE IF NOT EXISTS public.stripe_processed_invoices (
  stripe_invoice_id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  customer_id TEXT,
  plan_name TEXT,
  credits_granted INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER,
  currency TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup by user/customer for audit queries.
CREATE INDEX IF NOT EXISTS stripe_processed_invoices_user_idx
  ON public.stripe_processed_invoices(user_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS stripe_processed_invoices_customer_idx
  ON public.stripe_processed_invoices(customer_id, processed_at DESC);

-- RLS: service role only (the webhook runs with service role; users
-- never read this table directly — admin views can query via RPC).
ALTER TABLE public.stripe_processed_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only" ON public.stripe_processed_invoices;
CREATE POLICY "Service role only"
  ON public.stripe_processed_invoices
  FOR ALL USING (false);

COMMENT ON TABLE public.stripe_processed_invoices IS
  'C-7-13: per-invoice idempotency table for Stripe webhook handler. Insert with ON CONFLICT DO NOTHING before granting credits; if the row already exists, the invoice was processed and the grant is skipped.';

-- ============================================================
-- grant_monthly_credits_idempotent(p_invoice_id, p_user_id, ...)
-- ============================================================
-- Atomic transaction: records the invoice in stripe_processed_invoices,
-- and ONLY IF that INSERT actually adds a row (i.e. not a duplicate),
-- increments the user's credits balance and writes a credit_transactions
-- row. Returns the number of credits actually granted (0 if already
-- processed). Wrapping both writes in one plpgsql call means the credit
-- grant and the idempotency record can never get out of sync.
CREATE OR REPLACE FUNCTION public.grant_monthly_credits_idempotent(
  p_invoice_id TEXT,
  p_user_id UUID,
  p_customer_id TEXT,
  p_plan_name TEXT,
  p_credits INTEGER,
  p_amount_paid_cents INTEGER,
  p_currency TEXT,
  p_description TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rows_inserted INTEGER;
BEGIN
  IF p_invoice_id IS NULL OR p_invoice_id = '' THEN
    RAISE EXCEPTION 'invoice_id required for idempotent grant';
  END IF;

  -- Step 1: Reserve the invoice slot. If the row already exists
  -- (duplicate webhook), this inserts 0 rows and we short-circuit.
  INSERT INTO public.stripe_processed_invoices (
    stripe_invoice_id,
    user_id,
    customer_id,
    plan_name,
    credits_granted,
    amount_paid_cents,
    currency
  ) VALUES (
    p_invoice_id,
    p_user_id,
    p_customer_id,
    p_plan_name,
    p_credits,
    p_amount_paid_cents,
    p_currency
  )
  ON CONFLICT (stripe_invoice_id) DO NOTHING;

  GET DIAGNOSTICS v_rows_inserted = ROW_COUNT;
  IF v_rows_inserted = 0 THEN
    -- Already processed — return 0 so caller logs/skips.
    RETURN 0;
  END IF;

  -- Step 2: Grant credits + log transaction. Both writes run in the
  -- same transaction as the idempotency INSERT, so a failure rolls
  -- the whole thing back and Stripe's retry will get a fresh attempt.
  IF p_credits > 0 AND p_user_id IS NOT NULL THEN
    PERFORM public.increment_user_credits(
      p_user_id := p_user_id,
      p_credits := p_credits
    );

    INSERT INTO public.credit_transactions (
      user_id,
      amount,
      transaction_type,
      description
    ) VALUES (
      p_user_id,
      p_credits,
      'monthly_renewal',
      COALESCE(p_description, 'Monthly subscription credits')
    );
  END IF;

  RETURN p_credits;
END;
$$;

GRANT EXECUTE ON FUNCTION public.grant_monthly_credits_idempotent(
  TEXT, UUID, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT
) TO service_role;
COMMENT ON FUNCTION public.grant_monthly_credits_idempotent IS
  'C-7-13: atomic credit grant guarded by stripe_processed_invoices uniqueness. Returns credits granted (0 if invoice already processed).';
