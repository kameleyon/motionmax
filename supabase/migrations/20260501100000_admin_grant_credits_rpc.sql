-- ============================================================
-- admin_grant_credits — admin-only credit grant RPC
--
-- Adds credits to a user's balance and writes a transaction-log row
-- so the action is audited. Wraps the existing service-role-only
-- increment_user_credits() with an explicit admin check so the
-- browser admin client (authenticated JWT) can call it directly.
--
-- Usage from the admin dashboard:
--   supabase.rpc('admin_grant_credits', {
--     p_target_user_id: '...',
--     p_credits: 100,
--     p_reason: 'support refund — broken render'
--   });
--
-- Returns the user's new balance.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_grant_credits(
  p_target_user_id UUID,
  p_credits        INT,
  p_reason         TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  caller_id    UUID := auth.uid();
  new_balance  INT;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'admin_grant_credits: not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(caller_id) THEN
    RAISE EXCEPTION 'admin_grant_credits: admin access required' USING ERRCODE = '42501';
  END IF;

  IF p_credits IS NULL OR p_credits = 0 THEN
    RAISE EXCEPTION 'admin_grant_credits: p_credits must be a non-zero integer' USING ERRCODE = '22023';
  END IF;

  -- Range guard: a 7-digit number is almost certainly a typo. Cap to
  -- ±1,000,000 per call so a slipped finger can't blow up balances.
  IF p_credits > 1000000 OR p_credits < -1000000 THEN
    RAISE EXCEPTION 'admin_grant_credits: amount out of range (-1000000..1000000)' USING ERRCODE = '22023';
  END IF;

  -- Upsert. Negative grants are allowed (manual deduction) but never
  -- below zero — clamp via GREATEST.
  INSERT INTO public.user_credits (user_id, credits_balance, total_purchased)
  VALUES (
    p_target_user_id,
    GREATEST(p_credits, 0),
    GREATEST(p_credits, 0)
  )
  ON CONFLICT (user_id) DO UPDATE
    SET credits_balance = GREATEST(public.user_credits.credits_balance + p_credits, 0),
        -- total_purchased only counts positive admin grants (negative
        -- adjustments are reversals, not new purchases).
        total_purchased = public.user_credits.total_purchased + GREATEST(p_credits, 0),
        updated_at      = NOW()
  RETURNING credits_balance INTO new_balance;

  -- Audit log. credit_transactions table exists for this purpose;
  -- if the schema differs across environments we still want the
  -- grant itself to succeed — wrap in a sub-block.
  BEGIN
    INSERT INTO public.credit_transactions (
      user_id, transaction_type, amount, description, created_at
    ) VALUES (
      p_target_user_id,
      CASE WHEN p_credits >= 0 THEN 'admin_grant' ELSE 'admin_adjustment' END,
      p_credits,
      COALESCE(p_reason, 'Admin credit grant'),
      NOW()
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    -- credit_transactions schema mismatch — skip audit log, grant
    -- still succeeded.
    RAISE NOTICE 'credit_transactions audit insert skipped (schema mismatch)';
  END;

  RETURN new_balance;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_grant_credits(UUID, INT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.admin_grant_credits(UUID, INT, TEXT)
  IS 'Admin-only RPC: add (or subtract, if negative) credits from a user balance. Caller must pass is_admin(auth.uid()). Audited via credit_transactions when available. Returns new balance.';
