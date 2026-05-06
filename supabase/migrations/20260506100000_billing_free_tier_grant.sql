-- ============================================================
-- Billing & Plans page — Free tier signup grant + daily refresh
-- ------------------------------------------------------------
-- WHAT: Updates handle_new_user() to grant 900 one-time credits
--       (was 150) and seeds the daily_free_credits column on the
--       free-plan subscription row at 200 credits/day.
--
-- WHY:  User-confirmed pricing decision (2026-05-06):
--       - Free tier: 900 credits one-time + 200 daily refresh
--       - Creator: 500/mo (unchanged) — daily 60 from PLAN_LIMITS
--       - Studio:  2,500/mo (unchanged) — daily 150 from PLAN_LIMITS
--
-- IMPLEMENTS: Billing & Plans checklist section A.1.
-- ============================================================

BEGIN;

-- ── Add daily_free_credits column to subscriptions ──────────
-- Tracks the per-day refresh quota for each subscription row.
-- Free tier rows get 200, creator/studio get the existing
-- planLimits.dailyFreeCredits values applied via the daily cron.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS daily_free_credits int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.subscriptions.daily_free_credits IS
  'Per-day free-credit refresh quota. Applied by the daily-free-credits pg_cron job at 00:00 UTC.';

-- ── handle_new_user: 900 one-time credits, seed free sub row ─
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    safe_display_name TEXT;
BEGIN
    safe_display_name := COALESCE(
        substring(NEW.raw_user_meta_data->>'full_name', 1, 100),
        split_part(NEW.email, '@', 1)
    );
    safe_display_name := regexp_replace(safe_display_name, '[^a-zA-Z0-9 ''._-]', '', 'g');

    INSERT INTO public.profiles (user_id, display_name)
    VALUES (NEW.id, safe_display_name)
    ON CONFLICT (user_id) DO NOTHING;

    -- 900 one-time signup credits (was 150 before 2026-05-06)
    INSERT INTO public.user_credits (user_id, credits_balance, total_purchased, total_used)
    VALUES (NEW.id, 900, 900, 0)
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO public.credit_transactions (user_id, amount, transaction_type, description)
    VALUES (NEW.id, 900, 'signup_bonus', 'Free trial: 900 signup credits');

    -- Seed a free-plan subscription row so the daily-free-credits
    -- cron has something to update. stripe_customer_id is "manual"
    -- because there is no Stripe customer for free users.
    INSERT INTO public.subscriptions (
        user_id, stripe_customer_id, plan_name, status, daily_free_credits
    )
    VALUES (NEW.id, 'free:' || NEW.id::text, 'free', 'active', 200)
    ON CONFLICT (user_id) DO NOTHING;

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'handle_new_user failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── Add unique constraint on user_id if missing ─────────────
-- The handle_new_user upsert above relies on ON CONFLICT (user_id).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_user_id_key'
  ) THEN
    BEGIN
      ALTER TABLE public.subscriptions
        ADD CONSTRAINT subscriptions_user_id_key UNIQUE (user_id);
    EXCEPTION WHEN duplicate_table OR duplicate_object THEN
      -- already exists under a different name; ignore
      NULL;
    END;
  END IF;
END $$;

-- ── apply_daily_free_credits: cron-callable function ────────
-- Iterates active subscriptions and grants daily_free_credits to
-- each user once per UTC day. Idempotent via the existing
-- daily_credits_granted_at column on user_credits.
CREATE OR REPLACE FUNCTION public.apply_daily_free_credits()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  granted_count int := 0;
  rec record;
BEGIN
  FOR rec IN
    SELECT s.user_id, s.daily_free_credits
    FROM public.subscriptions s
    WHERE s.status = 'active'
      AND s.daily_free_credits > 0
  LOOP
    -- grant_daily_credits is idempotent per UTC day per user
    IF public.grant_daily_credits(rec.user_id, rec.daily_free_credits) THEN
      granted_count := granted_count + 1;
    END IF;
  END LOOP;

  RETURN granted_count;
END $$;

GRANT EXECUTE ON FUNCTION public.apply_daily_free_credits() TO service_role;

-- ── Schedule daily cron at 00:00 UTC ────────────────────────
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;

  -- Idempotent unschedule
  BEGIN
    PERFORM cron.unschedule('apply-daily-free-credits');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  PERFORM cron.schedule(
    'apply-daily-free-credits',
    '0 0 * * *',
    $cron$ SELECT public.apply_daily_free_credits(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule daily-free-credits cron: %', SQLERRM;
END $$;

-- ── Backfill existing free users to the new defaults ────────
UPDATE public.subscriptions s
SET daily_free_credits = 200
WHERE plan_name = 'free'
  AND status = 'active'
  AND daily_free_credits = 0;

-- Backfill creator (60/day) and studio (150/day) per planLimits.ts
UPDATE public.subscriptions
SET daily_free_credits = 60
WHERE plan_name = 'creator' AND status = 'active' AND daily_free_credits = 0;

UPDATE public.subscriptions
SET daily_free_credits = 150
WHERE plan_name IN ('studio', 'professional') AND status = 'active' AND daily_free_credits = 0;

COMMIT;
