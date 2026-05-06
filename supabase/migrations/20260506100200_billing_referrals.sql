-- ============================================================
-- Billing & Plans page — Referrals
-- ------------------------------------------------------------
-- WHAT: Two new tables (referral_codes, referral_signups) plus
--       a trigger + RPC that grants 1,000 credits to BOTH the
--       referrer and the referred user on the referred user's
--       first successful video generation.
--
-- WHY:  Powers the Referrals tab — copy/share link, history
--       table, KPIs (friends invited / joined / credits earned).
--
-- IMPLEMENTS: Billing & Plans checklist section A.4.
-- ============================================================

BEGIN;

-- ── referral_codes: one row per user, code is the public PK ─
CREATE TABLE IF NOT EXISTS public.referral_codes (
  code        text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_codes_user_id
  ON public.referral_codes(user_id);

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read THEIR OWN code
DROP POLICY IF EXISTS "Users read their own referral code" ON public.referral_codes;
CREATE POLICY "Users read their own referral code"
  ON public.referral_codes
  FOR SELECT
  USING (auth.uid() = user_id);

-- Anyone can read a code by exact-match lookup (for /r/CODE auth flow).
-- Anonymous lookup must be possible so the auth-redirect can resolve
-- a referral before the user has a session.
DROP POLICY IF EXISTS "Anyone reads code by exact match" ON public.referral_codes;
CREATE POLICY "Anyone reads code by exact match"
  ON public.referral_codes
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Users can create their own code (idempotent insert via
-- ensure_referral_code RPC below)
DROP POLICY IF EXISTS "Users create their own referral code" ON public.referral_codes;
CREATE POLICY "Users create their own referral code"
  ON public.referral_codes
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ── referral_signups: track who referred whom ───────────────
CREATE TABLE IF NOT EXISTS public.referral_signups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referred_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signed_up_at      timestamptz NOT NULL DEFAULT now(),
  first_render_at   timestamptz,
  credits_awarded   boolean NOT NULL DEFAULT false,
  CONSTRAINT referral_signups_unique_referred UNIQUE (referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_signups_referrer
  ON public.referral_signups(referrer_id);

ALTER TABLE public.referral_signups ENABLE ROW LEVEL SECURITY;

-- Users can see signups where THEY are the referrer (their KPI table)
DROP POLICY IF EXISTS "Users see their referral signups" ON public.referral_signups;
CREATE POLICY "Users see their referral signups"
  ON public.referral_signups
  FOR SELECT
  USING (auth.uid() = referrer_id OR auth.uid() = referred_id);

-- ── ensure_referral_code: idempotent code generation ────────
CREATE OR REPLACE FUNCTION public.ensure_referral_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  existing_code text;
  new_code text;
  attempt int := 0;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT code INTO existing_code FROM public.referral_codes WHERE user_id = uid;
  IF existing_code IS NOT NULL THEN
    RETURN existing_code;
  END IF;

  -- Generate a short alphanumeric code derived from the user id +
  -- a 4-char random suffix. Retry on collision (extremely unlikely).
  LOOP
    new_code := lower(substring(replace(uid::text, '-', ''), 1, 6))
                || '-'
                || upper(substring(md5(random()::text || clock_timestamp()::text), 1, 6));
    BEGIN
      INSERT INTO public.referral_codes (code, user_id) VALUES (new_code, uid);
      RETURN new_code;
    EXCEPTION WHEN unique_violation THEN
      attempt := attempt + 1;
      IF attempt > 5 THEN
        RAISE EXCEPTION 'Could not allocate referral code';
      END IF;
    END;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.ensure_referral_code() TO authenticated;

-- ── record_referral_signup: called from auth flow / app ─────
-- Records that referred_user signed up via referrer_user's code.
-- Idempotent on the (referred_id) unique constraint.
CREATE OR REPLACE FUNCTION public.record_referral_signup(
  p_referral_code text,
  p_referred_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referrer_id uuid;
BEGIN
  SELECT user_id INTO v_referrer_id
  FROM public.referral_codes
  WHERE code = p_referral_code;

  IF v_referrer_id IS NULL OR v_referrer_id = p_referred_id THEN
    RETURN false;
  END IF;

  INSERT INTO public.referral_signups (referrer_id, referred_id)
  VALUES (v_referrer_id, p_referred_id)
  ON CONFLICT (referred_id) DO NOTHING;

  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION public.record_referral_signup(text, uuid) TO authenticated, service_role;

-- ── apply_referral_credit: grants 1000 credits to BOTH parties
-- Called from the generation pipeline on first successful render
-- for the referred user. Idempotent via credits_awarded flag.
CREATE OR REPLACE FUNCTION public.apply_referral_credit(p_referred_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referrer_id uuid;
  v_already boolean;
BEGIN
  SELECT referrer_id, credits_awarded
  INTO v_referrer_id, v_already
  FROM public.referral_signups
  WHERE referred_id = p_referred_user_id;

  IF v_referrer_id IS NULL OR v_already THEN
    RETURN false;
  END IF;

  -- Award 1000 credits to each side
  PERFORM public.increment_user_credits(v_referrer_id, 1000);
  PERFORM public.increment_user_credits(p_referred_user_id, 1000);

  INSERT INTO public.credit_transactions (user_id, amount, transaction_type, description)
  VALUES
    (v_referrer_id, 1000, 'referral_bonus', 'Referral reward — friend completed first render'),
    (p_referred_user_id, 1000, 'referral_bonus', 'Welcome bonus — joined via referral');

  UPDATE public.referral_signups
  SET first_render_at = now(),
      credits_awarded = true
  WHERE referred_id = p_referred_user_id;

  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION public.apply_referral_credit(uuid) TO authenticated, service_role;

-- ── Aggregated KPI RPC for the Referrals tab ────────────────
CREATE OR REPLACE FUNCTION public.referral_user_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  invited_count int := 0;
  joined_count int := 0;
  credits_earned int := 0;
  v_code text;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT code INTO v_code FROM public.referral_codes WHERE user_id = uid;

  SELECT count(*)::int INTO invited_count
  FROM public.referral_signups WHERE referrer_id = uid;

  SELECT count(*)::int INTO joined_count
  FROM public.referral_signups
  WHERE referrer_id = uid AND credits_awarded = true;

  credits_earned := joined_count * 1000;

  RETURN jsonb_build_object(
    'code', v_code,
    'invited_count', invited_count,
    'joined_count', joined_count,
    'credits_earned', credits_earned
  );
END $$;

GRANT EXECUTE ON FUNCTION public.referral_user_summary() TO authenticated;

COMMIT;
