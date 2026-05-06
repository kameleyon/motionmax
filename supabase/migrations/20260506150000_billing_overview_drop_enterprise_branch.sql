-- ============================================================
-- Drop the enterprise branch from billing_user_overview()
-- ------------------------------------------------------------
-- WHY:
--   Enterprise is no longer a sold tier. Previously, billing_user_overview
--   gave plan_name='enterprise' a hard-coded 999_999 monthly_allowance,
--   which made the Billing > Overview tab show "infinite" for legacy
--   manual / comp accounts. We now treat enterprise rows the same as
--   studio (2_500 * pack_quantity) so the UI is honest about the cap
--   they actually have. Studio behavior is otherwise unchanged.
--
-- The historical migration 20260506100400_billing_overview_and_settings.sql
-- is left untouched — this migration overrides the function body.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.billing_user_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  v_credits int := 0;
  v_total_purchased int := 0;
  v_total_used int := 0;
  v_plan text := 'free';
  v_status text := 'active';
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_pack_quantity int := 1;
  v_paused_until timestamptz;
  v_used_this_month int := 0;
  v_video_used int := 0;
  v_voice_used int := 0;
  v_image_used int := 0;
  v_other_used int := 0;
  v_ytd_spend numeric := 0;
  v_videos_rendered int := 0;
  v_avg_per_day numeric := 0;
  v_runway_days int := 0;
  v_monthly_allowance int := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- Credits
  SELECT credits_balance, total_purchased, total_used
  INTO v_credits, v_total_purchased, v_total_used
  FROM public.user_credits WHERE user_id = uid;

  v_credits := COALESCE(v_credits, 0);
  v_total_purchased := COALESCE(v_total_purchased, 0);
  v_total_used := COALESCE(v_total_used, 0);

  -- Subscription
  SELECT plan_name, status::text, current_period_start, current_period_end,
         pack_quantity, paused_until
  INTO v_plan, v_status, v_period_start, v_period_end, v_pack_quantity, v_paused_until
  FROM public.subscriptions
  WHERE user_id = uid AND status = 'active'
  ORDER BY created_at DESC
  LIMIT 1;

  v_plan := COALESCE(v_plan, 'free');
  v_pack_quantity := COALESCE(v_pack_quantity, 1);

  -- Enterprise is no longer sold; legacy enterprise rows fall through
  -- to the studio monthly allowance (2500 * pack_quantity). 'professional'
  -- is the legacy label for what is now called 'studio' — both kept.
  v_monthly_allowance := CASE v_plan
    WHEN 'creator' THEN 500 * v_pack_quantity
    WHEN 'studio' THEN 2500 * v_pack_quantity
    WHEN 'professional' THEN 2500 * v_pack_quantity
    WHEN 'enterprise' THEN 2500 * v_pack_quantity
    ELSE 0
  END;

  -- Used this month — sum negative usage transactions in current period
  IF v_period_start IS NULL THEN
    v_period_start := date_trunc('month', now());
  END IF;

  SELECT COALESCE(SUM(-amount), 0)::int INTO v_used_this_month
  FROM public.credit_transactions
  WHERE user_id = uid
    AND amount < 0
    AND created_at >= v_period_start;

  -- Category breakdown — best-effort using description text
  SELECT COALESCE(SUM(-amount), 0)::int INTO v_video_used
  FROM public.credit_transactions
  WHERE user_id = uid AND amount < 0 AND created_at >= v_period_start
    AND (description ILIKE '%video%' OR description ILIKE '%cinematic%' OR description ILIKE '%explainer%');

  SELECT COALESCE(SUM(-amount), 0)::int INTO v_voice_used
  FROM public.credit_transactions
  WHERE user_id = uid AND amount < 0 AND created_at >= v_period_start
    AND (description ILIKE '%voice%' OR description ILIKE '%tts%' OR description ILIKE '%narration%');

  SELECT COALESCE(SUM(-amount), 0)::int INTO v_image_used
  FROM public.credit_transactions
  WHERE user_id = uid AND amount < 0 AND created_at >= v_period_start
    AND (description ILIKE '%image%' OR description ILIKE '%scene%');

  v_other_used := GREATEST(0, v_used_this_month - v_video_used - v_voice_used - v_image_used);

  -- YTD spend (purchase transactions, sum positive amounts paid)
  SELECT COALESCE(SUM(amount), 0) * 0.01 INTO v_ytd_spend
  FROM public.credit_transactions
  WHERE user_id = uid
    AND transaction_type IN ('purchase', 'monthly_renewal')
    AND created_at >= date_trunc('year', now());

  -- Videos rendered this month
  SELECT count(*)::int INTO v_videos_rendered
  FROM public.projects
  WHERE user_id = uid
    AND created_at >= v_period_start;

  -- Avg/day + runway
  v_avg_per_day := CASE
    WHEN v_period_start IS NOT NULL
      AND extract(epoch FROM (now() - v_period_start)) > 0
    THEN v_used_this_month / GREATEST(extract(epoch FROM (now() - v_period_start)) / 86400.0, 1)
    ELSE 0
  END;

  v_runway_days := CASE
    WHEN v_avg_per_day > 0 THEN floor(v_credits / v_avg_per_day)::int
    ELSE 0
  END;

  RETURN jsonb_build_object(
    'plan', v_plan,
    'status', v_status,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'pack_quantity', v_pack_quantity,
    'paused_until', v_paused_until,
    'credits_balance', v_credits,
    'monthly_allowance', v_monthly_allowance,
    'used_this_month', v_used_this_month,
    'video_used', v_video_used,
    'voice_used', v_voice_used,
    'image_used', v_image_used,
    'other_used', v_other_used,
    'videos_rendered', v_videos_rendered,
    'ytd_spend', v_ytd_spend,
    'avg_per_day', v_avg_per_day,
    'runway_days', v_runway_days,
    'total_purchased', v_total_purchased,
    'total_used', v_total_used
  );
END $$;

GRANT EXECUTE ON FUNCTION public.billing_user_overview() TO authenticated;

COMMIT;
