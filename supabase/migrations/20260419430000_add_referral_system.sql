-- Add referral system: referral_codes + referral_uses tables and associated
-- SQL functions (generate_referral_code, apply_referral_code,
-- award_referral_credits).
--
-- Credit awards on first generation:
--   referrer: +150 credits
--   referred: +75 credits
--
-- Security model:
--   • authenticated users read/write only their own referral_codes row
--   • authenticated users read referral_uses rows where they are the referrer
--   • award_referral_credits is SECURITY DEFINER so the worker (service_role)
--     can call it — mirrors the pattern used by refund_credits_securely

-- ── Tables ─────────────────────────────────────────────────────────

CREATE TABLE public.referral_codes (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code                 TEXT        NOT NULL,
  total_referrals      INT         NOT NULL DEFAULT 0,
  total_credits_earned INT         NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT referral_codes_user_id_key  UNIQUE (user_id),
  CONSTRAINT referral_codes_code_key     UNIQUE (code)
);

CREATE TABLE public.referral_uses (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referred_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referrer_credits_awarded INT        NOT NULL DEFAULT 0,
  referred_credits_awarded INT        NOT NULL DEFAULT 0,
  completed_at            TIMESTAMPTZ,          -- NULL until first generation triggers the award
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT referral_uses_referred_id_key UNIQUE (referred_id)  -- one referral per new user
);

-- Indexes for common look-up patterns
CREATE INDEX referral_uses_referrer_id_idx ON public.referral_uses (referrer_id);
CREATE INDEX referral_uses_referred_id_idx ON public.referral_uses (referred_id);

-- ── Row-Level Security ─────────────────────────────────────────────

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_uses  ENABLE ROW LEVEL SECURITY;

-- referral_codes: users can SELECT and INSERT their own row only
CREATE POLICY "referral_codes_select_own"
  ON public.referral_codes FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "referral_codes_insert_own"
  ON public.referral_codes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- referral_uses: referrers can read their own referral rows
-- (referred_id side is kept private to avoid user enumeration)
CREATE POLICY "referral_uses_select_own"
  ON public.referral_uses FOR SELECT
  USING (auth.uid() = referrer_id);

-- ── generate_referral_code ────────────────────────────────────────
-- Creates a new referral code for p_user_id if none exists,
-- otherwise returns the existing one. Idempotent.
--
-- Code format: "MM-" + 6 uppercase alphanumeric chars, e.g. "MM-A3F9X2"

CREATE OR REPLACE FUNCTION public.generate_referral_code(
  p_user_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  existing_code TEXT;
  new_code      TEXT;
  chars         TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- omit O,0,1,I for readability
  i             INT;
  attempts      INT := 0;
BEGIN
  -- Return existing code if one already exists
  SELECT code INTO existing_code
  FROM referral_codes
  WHERE user_id = p_user_id;

  IF existing_code IS NOT NULL THEN
    RETURN existing_code;
  END IF;

  -- Generate a unique 6-char code with collision retry
  LOOP
    new_code := 'MM-';
    FOR i IN 1..6 LOOP
      new_code := new_code || substr(chars, floor(random() * length(chars))::int + 1, 1);
    END LOOP;

    -- Insert with ON CONFLICT on code — retries on collision
    BEGIN
      INSERT INTO referral_codes (user_id, code)
      VALUES (p_user_id, new_code)
      ON CONFLICT (user_id) DO NOTHING;  -- another concurrent call may have won

      -- Check we actually inserted or that the row now exists for this user
      SELECT code INTO existing_code
      FROM referral_codes
      WHERE user_id = p_user_id;

      IF existing_code IS NOT NULL THEN
        RETURN existing_code;
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        -- Code collision — try again
        NULL;
    END;

    attempts := attempts + 1;
    IF attempts > 20 THEN
      RAISE EXCEPTION 'generate_referral_code: too many collision retries for user %', p_user_id;
    END IF;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_referral_code(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_referral_code(UUID) TO service_role;

-- ── apply_referral_code ───────────────────────────────────────────
-- Called at signup when the new user provides a referral code.
-- Returns the referrer's user_id on success, NULL on any failure.
--
-- Failure conditions (all return NULL silently):
--   • code does not exist
--   • self-referral
--   • referred user already has a referral_uses row (duplicate)

CREATE OR REPLACE FUNCTION public.apply_referral_code(
  p_code            TEXT,
  p_referred_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_referrer_id UUID;
BEGIN
  -- Look up referrer
  SELECT user_id INTO v_referrer_id
  FROM referral_codes
  WHERE code = p_code;

  IF v_referrer_id IS NULL THEN
    RETURN NULL;  -- code not found
  END IF;

  -- Prevent self-referral
  IF v_referrer_id = p_referred_user_id THEN
    RETURN NULL;
  END IF;

  -- Insert referral_uses row (UNIQUE on referred_id prevents duplicates)
  INSERT INTO referral_uses (referrer_id, referred_id)
  VALUES (v_referrer_id, p_referred_user_id)
  ON CONFLICT (referred_id) DO NOTHING;

  -- Return NULL if the INSERT was a no-op (user already referred)
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN v_referrer_id;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'apply_referral_code failed for code % / user %: %', p_code, p_referred_user_id, SQLERRM;
    RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_referral_code(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_referral_code(TEXT, UUID) TO service_role;

-- ── award_referral_credits ────────────────────────────────────────
-- Called by the worker after a user's FIRST successful generation.
-- Awards 150 credits to the referrer and 75 credits to the referred user.
-- Idempotent: does nothing if completed_at is already set.
-- Never throws — returns FALSE on any failure so the worker stays safe.

CREATE OR REPLACE FUNCTION public.award_referral_credits(
  p_referred_user_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_referral_use  referral_uses%ROWTYPE;
  v_referrer_credits CONSTANT INT := 150;
  v_referred_credits CONSTANT INT := 75;
BEGIN
  -- Find pending referral for this user (lock row to prevent concurrent awards)
  SELECT * INTO v_referral_use
  FROM referral_uses
  WHERE referred_id = p_referred_user_id
    AND completed_at IS NULL
  FOR UPDATE SKIP LOCKED;

  -- No pending referral — nothing to do (idempotent)
  IF v_referral_use.id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- ── Award credits to referrer ──────────────────────────────────

  -- Upsert user_credits row (referrer may not have one if they've never generated)
  INSERT INTO user_credits (user_id, credits_balance, total_purchased, total_used)
  VALUES (v_referral_use.referrer_id, v_referrer_credits, v_referrer_credits, 0)
  ON CONFLICT (user_id) DO UPDATE
  SET credits_balance = user_credits.credits_balance + v_referrer_credits,
      total_purchased = user_credits.total_purchased  + v_referrer_credits,
      updated_at      = NOW();

  INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
  VALUES (
    v_referral_use.referrer_id,
    v_referrer_credits,
    'referral',
    'Referral reward: friend completed first video generation'
  );

  -- ── Award credits to referred user ────────────────────────────

  INSERT INTO user_credits (user_id, credits_balance, total_purchased, total_used)
  VALUES (p_referred_user_id, v_referred_credits, v_referred_credits, 0)
  ON CONFLICT (user_id) DO UPDATE
  SET credits_balance = user_credits.credits_balance + v_referred_credits,
      total_purchased = user_credits.total_purchased  + v_referred_credits,
      updated_at      = NOW();

  INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
  VALUES (
    p_referred_user_id,
    v_referred_credits,
    'referral',
    'Welcome bonus: credited for joining via referral'
  );

  -- ── Mark referral complete and update counters ─────────────────

  UPDATE referral_uses
  SET completed_at             = NOW(),
      referrer_credits_awarded = v_referrer_credits,
      referred_credits_awarded = v_referred_credits
  WHERE id = v_referral_use.id;

  UPDATE referral_codes
  SET total_referrals      = total_referrals + 1,
      total_credits_earned = total_credits_earned + v_referrer_credits
  WHERE user_id = v_referral_use.referrer_id;

  RETURN TRUE;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'award_referral_credits failed for referred user %: %', p_referred_user_id, SQLERRM;
    RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.award_referral_credits(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.award_referral_credits(UUID) TO service_role;
