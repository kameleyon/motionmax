-- ============================================================
-- Update pricing system: per-second credits
-- Free trial: 150 credits (one-time, no monthly renewal)
-- Creator: 500/month + 60 daily
-- Studio: 2500/month + 150 daily
-- ============================================================

-- Update handle_new_user to give 150 free trial credits (was 10)
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

    -- 150 free trial credits for new users
    INSERT INTO public.user_credits (user_id, credits_balance, total_purchased, total_used)
    VALUES (NEW.id, 150, 150, 0)
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO public.credit_transactions (user_id, amount, transaction_type, description)
    VALUES (NEW.id, 150, 'signup_bonus', 'Free trial: 150 credits');

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'handle_new_user failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Add daily_credits_granted_at column to track daily bonus
ALTER TABLE public.user_credits
  ADD COLUMN IF NOT EXISTS daily_credits_granted_at DATE;

-- Function to grant daily free credits (called before generation)
CREATE OR REPLACE FUNCTION public.grant_daily_credits(
  p_user_id UUID,
  p_daily_amount INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  last_grant DATE;
BEGIN
  SELECT daily_credits_granted_at INTO last_grant
  FROM user_credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Already granted today
  IF last_grant IS NOT NULL AND last_grant = CURRENT_DATE THEN
    RETURN FALSE;
  END IF;

  -- Grant daily credits
  UPDATE user_credits
  SET credits_balance = credits_balance + p_daily_amount,
      daily_credits_granted_at = CURRENT_DATE,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  -- Log the grant
  INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
  VALUES (p_user_id, p_daily_amount, 'daily_bonus', 'Daily bonus credits: ' || p_daily_amount);

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.grant_daily_credits(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.grant_daily_credits(UUID, INT) TO authenticated;
