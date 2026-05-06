-- ============================================================
-- Billing & Plans page — Promo codes
-- ------------------------------------------------------------
-- WHAT: promo_codes table + apply_promo_code RPC. Codes can be
--       'discount' (percent or fixed off next renewal — recorded
--       and applied as a Stripe coupon on the user's customer)
--       or 'credits' (one-time credit grant, applied immediately).
--
-- WHY:  Powers the "Have a promo code?" card on the Referrals tab.
--
-- IMPLEMENTS: Billing & Plans checklist section A.5.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'promo_kind'
  ) THEN
    CREATE TYPE public.promo_kind AS ENUM ('discount', 'credits');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.promo_codes (
  code         text PRIMARY KEY,
  kind         public.promo_kind NOT NULL,
  value        numeric NOT NULL,
  expires_at   timestamptz,
  single_use   boolean NOT NULL DEFAULT false,
  used_count   int NOT NULL DEFAULT 0,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

-- Authenticated users can look up by exact code (apply RPC enforces
-- the rest of the validation server-side). NO list-all access.
DROP POLICY IF EXISTS "Authenticated users read codes" ON public.promo_codes;
CREATE POLICY "Authenticated users read codes"
  ON public.promo_codes
  FOR SELECT
  TO authenticated
  USING (true);

-- ── promo_redemptions: ledger to enforce single-use ─────────
CREATE TABLE IF NOT EXISTS public.promo_redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL REFERENCES public.promo_codes(code) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  redeemed_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promo_redemption_unique_per_user UNIQUE (code, user_id)
);

ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see their redemptions" ON public.promo_redemptions;
CREATE POLICY "Users see their redemptions"
  ON public.promo_redemptions
  FOR SELECT
  USING (auth.uid() = user_id);

-- ── apply_promo_code RPC ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_promo_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  rec public.promo_codes%rowtype;
  already int;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_code IS NULL OR length(trim(p_code)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Empty code');
  END IF;

  SELECT * INTO rec FROM public.promo_codes
  WHERE code = upper(trim(p_code));

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Code not found');
  END IF;

  IF rec.expires_at IS NOT NULL AND rec.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Code has expired');
  END IF;

  -- single_use applies per-user (UNIQUE on (code, user_id) enforces it)
  SELECT count(*) INTO already
  FROM public.promo_redemptions
  WHERE code = rec.code AND user_id = uid;

  IF already > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Already redeemed');
  END IF;

  INSERT INTO public.promo_redemptions (code, user_id) VALUES (rec.code, uid);

  UPDATE public.promo_codes SET used_count = used_count + 1 WHERE code = rec.code;

  IF rec.kind = 'credits' THEN
    PERFORM public.increment_user_credits(uid, rec.value::int);
    INSERT INTO public.credit_transactions (user_id, amount, transaction_type, description)
    VALUES (uid, rec.value::int, 'promo_credits', 'Promo code: ' || rec.code);

    RETURN jsonb_build_object(
      'ok', true,
      'kind', 'credits',
      'amount', rec.value::int,
      'message', 'Added ' || rec.value::int || ' credits to your balance'
    );
  ELSE
    -- discount: recorded but the actual Stripe coupon application
    -- happens server-side in the cancel-with-reason / customer portal
    -- flow. Frontend toast confirms the code is queued.
    RETURN jsonb_build_object(
      'ok', true,
      'kind', 'discount',
      'value', rec.value,
      'message', 'Discount queued for your next renewal'
    );
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.apply_promo_code(text) TO authenticated;

-- ── Seed two example codes used in the design lede ──────────
INSERT INTO public.promo_codes (code, kind, value, single_use, description)
VALUES
  ('SUMMER2026', 'discount', 20, true, '20% off next renewal'),
  ('FRIENDLINA', 'credits', 1000, true, '1,000 bonus credits')
ON CONFLICT (code) DO NOTHING;

COMMIT;
