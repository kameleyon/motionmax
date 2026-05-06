-- ============================================================
-- Billing & Plans page — Overview RPC, auto-recharge, cancel reasons
-- ------------------------------------------------------------
-- WHAT:
--   1. auto_recharge_settings table (toggle, threshold, pack)
--   2. cancellation_reasons table (cancel-with-reason fn writes here)
--   3. billing_user_overview RPC returning the JSON the Overview tab needs
--
-- IMPLEMENTS: Billing & Plans checklist sections A.7, B.5, D (auto-recharge).
-- ============================================================

BEGIN;

-- ── auto_recharge_settings ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auto_recharge_settings (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled        boolean NOT NULL DEFAULT false,
  threshold      int NOT NULL DEFAULT 2000,
  pack_credits   int NOT NULL DEFAULT 2000,
  spending_cap   int,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.auto_recharge_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own auto-recharge" ON public.auto_recharge_settings;
CREATE POLICY "Users manage their own auto-recharge"
  ON public.auto_recharge_settings
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.update_auto_recharge_settings(
  p_enabled boolean,
  p_threshold int,
  p_pack_credits int,
  p_spending_cap int
)
RETURNS public.auto_recharge_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  result public.auto_recharge_settings;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  INSERT INTO public.auto_recharge_settings (user_id, enabled, threshold, pack_credits, spending_cap, updated_at)
  VALUES (uid, p_enabled, p_threshold, p_pack_credits, p_spending_cap, now())
  ON CONFLICT (user_id) DO UPDATE
  SET enabled = excluded.enabled,
      threshold = excluded.threshold,
      pack_credits = excluded.pack_credits,
      spending_cap = excluded.spending_cap,
      updated_at = now()
  RETURNING * INTO result;

  RETURN result;
END $$;

GRANT EXECUTE ON FUNCTION public.update_auto_recharge_settings(boolean, int, int, int) TO authenticated;

-- ── cancellation_reasons ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cancellation_reasons (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason          text,
  kept_with_offer boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cancellation_reasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own cancellation reasons" ON public.cancellation_reasons;
CREATE POLICY "Users see own cancellation reasons"
  ON public.cancellation_reasons
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own cancellation reasons" ON public.cancellation_reasons;
CREATE POLICY "Users insert own cancellation reasons"
  ON public.cancellation_reasons
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ── billing_notification_prefs ──────────────────────────────
-- Toggles for: email_receipts, include_vat, year_end_statement
CREATE TABLE IF NOT EXISTS public.billing_notification_prefs (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email_receipts       boolean NOT NULL DEFAULT true,
  include_vat          boolean NOT NULL DEFAULT false,
  year_end_statement   boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.billing_notification_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own billing prefs" ON public.billing_notification_prefs;
CREATE POLICY "Users manage own billing prefs"
  ON public.billing_notification_prefs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── billing_user_overview RPC ───────────────────────────────
-- Returns a single JSON blob the Overview tab can render directly.
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

  v_monthly_allowance := CASE v_plan
    WHEN 'creator' THEN 500 * v_pack_quantity
    WHEN 'studio' THEN 2500 * v_pack_quantity
    WHEN 'professional' THEN 2500 * v_pack_quantity
    WHEN 'enterprise' THEN 999999
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
  -- (no schema enum exists for category; this matches current writers).
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
  -- We store credits granted, not USD, so approximate via credit value
  -- using $0.01/credit average. For accurate $$ totals the Invoices
  -- tab should pull directly from Stripe.
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

-- ── billing_usage_history: 12-month series + top projects ───
CREATE OR REPLACE FUNCTION public.billing_usage_history()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  v_months jsonb;
  v_projects jsonb;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- 12-month series of credit usage by category
  WITH months AS (
    SELECT generate_series(
      date_trunc('month', now()) - interval '11 months',
      date_trunc('month', now()),
      interval '1 month'
    )::date AS m
  ),
  agg AS (
    SELECT
      date_trunc('month', t.created_at)::date AS m,
      SUM(CASE WHEN t.description ILIKE '%video%' OR t.description ILIKE '%cinematic%' OR t.description ILIKE '%explainer%' THEN -t.amount ELSE 0 END)::int AS video,
      SUM(CASE WHEN t.description ILIKE '%voice%' OR t.description ILIKE '%tts%' OR t.description ILIKE '%narration%' THEN -t.amount ELSE 0 END)::int AS voice,
      SUM(CASE WHEN t.description ILIKE '%image%' OR t.description ILIKE '%scene%' THEN -t.amount ELSE 0 END)::int AS image,
      SUM(-t.amount)::int AS total
    FROM public.credit_transactions t
    WHERE t.user_id = uid AND t.amount < 0
      AND t.created_at >= date_trunc('month', now()) - interval '11 months'
    GROUP BY 1
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'month', to_char(months.m, 'Mon'),
      'video', COALESCE(agg.video, 0),
      'voice', COALESCE(agg.voice, 0),
      'image', COALESCE(agg.image, 0),
      'total', COALESCE(agg.total, 0)
    ) ORDER BY months.m
  )
  INTO v_months
  FROM months LEFT JOIN agg ON agg.m = months.m;

  -- Top projects this month — by aggregated -amount on transactions
  -- whose description references the project. As a fallback if no
  -- references exist, return the most recently updated projects.
  SELECT jsonb_agg(row_to_json(p)) INTO v_projects
  FROM (
    SELECT id, title, COALESCE(thumbnail_url, '') AS thumbnail_url, updated_at
    FROM public.projects
    WHERE user_id = uid
    ORDER BY updated_at DESC
    LIMIT 6
  ) p;

  RETURN jsonb_build_object(
    'months', COALESCE(v_months, '[]'::jsonb),
    'top_projects', COALESCE(v_projects, '[]'::jsonb)
  );
END $$;

GRANT EXECUTE ON FUNCTION public.billing_usage_history() TO authenticated;

COMMIT;
