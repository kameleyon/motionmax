-- grant_daily_credits previously accepted p_daily_amount from the caller, allowing any service_role
-- caller to grant unlimited credits by passing an arbitrary value.
-- This migration replaces it with a version that looks up the user's active plan and applies a
-- hardcoded per-plan cap, ignoring any caller-supplied amount entirely.

-- Drop the old function signature so the new (UUID-only) signature is unambiguous.
DROP FUNCTION IF EXISTS public.grant_daily_credits(UUID, INT);

CREATE OR REPLACE FUNCTION public.grant_daily_credits(
  p_user_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  last_grant  DATE;
  plan        TEXT;
  daily_limit INT;
BEGIN
  -- Resolve the user's active plan tier.
  SELECT plan_name INTO plan
  FROM subscriptions
  WHERE user_id = p_user_id AND status = 'active'
  ORDER BY created_at DESC
  LIMIT 1;

  -- Enforce per-plan daily credit limits; callers cannot override these values.
  daily_limit := CASE COALESCE(plan, 'free')
    WHEN 'free'         THEN 10
    WHEN 'starter'      THEN 25
    WHEN 'creator'      THEN 50
    WHEN 'professional' THEN 100
    WHEN 'enterprise'   THEN 200
    ELSE 10
  END;

  -- Lock the row before reading to avoid race conditions with concurrent calls.
  SELECT daily_credits_granted_at INTO last_grant
  FROM user_credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Already granted today — idempotent no-op.
  IF last_grant IS NOT NULL AND last_grant = CURRENT_DATE THEN
    RETURN FALSE;
  END IF;

  UPDATE user_credits
  SET credits_balance          = credits_balance + daily_limit,
      daily_credits_granted_at = CURRENT_DATE,
      updated_at               = NOW()
  WHERE user_id = p_user_id;

  INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
  VALUES (
    p_user_id,
    daily_limit,
    'daily_bonus',
    'Daily bonus credits: ' || daily_limit || ' (' || COALESCE(plan, 'free') || ' plan)'
  );

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.grant_daily_credits(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.grant_daily_credits(UUID) TO authenticated;
