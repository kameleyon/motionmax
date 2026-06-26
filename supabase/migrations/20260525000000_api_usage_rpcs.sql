-- ─────────────────────────────────────────────────────────────────────────────
-- MotionMax Public API — tenant-scoped USAGE RPCs (Phase 3 §"Public usage API").
--
-- These power GET /api/v1/usage: balance, per-period spend, per-call cost
-- breakdown. They are the customer-facing equivalent of the is_admin-gated
-- admin_api_cost_* RPCs (20260505220000) — but scoped to ONE account, never the
-- whole fleet.
--
-- Attribution path: api_call_logs has no account_id, so cost is attributed via
--   api_call_logs.job_id  →  video_generation_jobs.account_id
-- (the account_id column was added in 20260524000100; idx_api_call_logs_job_id
-- exists). Only API-originated jobs carry account_id, so browser jobs never
-- leak into a tenant's usage view.
--
-- Owner scoping: api_usage_summary asserts api_assert_account_owner(p_account_id)
-- so a JWT caller (auth.uid() set) can only read THEIR OWN account. The public
-- gateway calls these with the service-role client (auth.uid() = NULL), for
-- which api_assert_account_owner raises '42501' — so the gateway must NOT route
-- through the owner assertion. The summary RPC therefore skips the assertion
-- when auth.uid() IS NULL (service-role), trusting the gateway to pass the
-- already-authenticated account.id from requireApiKey. JWT callers are still
-- fully owner-checked. api_spend_breakdown follows the same rule.
--
-- Idempotent: CREATE OR REPLACE; safe to re-run. SECURITY DEFINER with a pinned
-- search_path; EXECUTE granted to authenticated (service_role implicit).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. api_usage_summary(p_account_id, p_since)
--    → jsonb { calls, total_cost_usd, jobs, since, credits_balance }
--
-- calls          — api_call_logs rows for this account since p_since
-- total_cost_usd — SUM(api_call_logs.cost) over those rows
-- jobs           — distinct video_generation_jobs attributed
-- credits_balance — current wallet balance of the account owner (per-user wallet)
-- since          — echoes the window start for the caller
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_usage_summary(
  p_account_id uuid,
  p_since      timestamptz DEFAULT now() - INTERVAL '30 days'
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_owner   uuid;
  v_calls   bigint;
  v_cost    numeric;
  v_jobs    bigint;
  v_balance integer;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'api_usage_summary: account_id is required' USING ERRCODE = '22023';
  END IF;

  -- JWT callers (auth.uid() set) are owner-checked. The service-role gateway
  -- (auth.uid() = NULL) bypasses, trusting the authenticated account.id passed
  -- by requireApiKey — keeping the query tenant-scoped without an owner row.
  IF auth.uid() IS NOT NULL THEN
    PERFORM public.api_assert_account_owner(p_account_id);
  END IF;

  -- Owner of this account (per-user credit wallet lives on accounts.owner_user_id).
  SELECT a.owner_user_id INTO v_owner
    FROM public.accounts a
   WHERE a.id = p_account_id;

  -- Usage aggregate: attribute api_call_logs → jobs → account.
  SELECT
    COUNT(*)::bigint,
    COALESCE(SUM(l.cost), 0)::numeric,
    COUNT(DISTINCT j.id)::bigint
  INTO v_calls, v_cost, v_jobs
  FROM public.api_call_logs l
  JOIN public.video_generation_jobs j ON l.job_id = j.id
  WHERE j.account_id = p_account_id
    AND l.created_at >= p_since;

  -- Current wallet balance for the account owner.
  SELECT uc.credits_balance INTO v_balance
    FROM public.user_credits uc
   WHERE uc.user_id = v_owner;

  RETURN jsonb_build_object(
    'calls',           COALESCE(v_calls, 0),
    'total_cost_usd',  COALESCE(v_cost, 0),
    'jobs',            COALESCE(v_jobs, 0),
    'credits_balance', COALESCE(v_balance, 0),
    'since',           p_since
  );
END;
$func$;

REVOKE ALL    ON FUNCTION public.api_usage_summary(uuid, timestamptz) FROM anon;
GRANT  EXECUTE ON FUNCTION public.api_usage_summary(uuid, timestamptz) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. api_spend_breakdown(p_account_id, p_since, p_group_by)
--    → TABLE(label text, calls bigint, spend numeric, avg_ms numeric)
--
-- p_group_by ∈ 'provider' | 'model' | 'day'. Same join + tenant filter as the
-- summary. Tenant-scoped equivalent of admin_api_cost_breakdown but bounded to
-- a single account. Owner-checked for JWT callers; service-role bypasses.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_spend_breakdown(
  p_account_id uuid,
  p_since      timestamptz DEFAULT now() - INTERVAL '30 days',
  p_group_by   text        DEFAULT 'provider'
)
RETURNS TABLE (
  label   text,
  calls   bigint,
  spend   numeric,
  avg_ms  numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'api_spend_breakdown: account_id is required' USING ERRCODE = '22023';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    PERFORM public.api_assert_account_owner(p_account_id);
  END IF;

  IF p_group_by = 'provider' THEN
    RETURN QUERY
    SELECT
      COALESCE(l.provider, 'unknown')::text         AS label,
      COUNT(*)::bigint                              AS calls,
      COALESCE(SUM(l.cost), 0)::numeric             AS spend,
      COALESCE(AVG(l.total_duration_ms), 0)::numeric AS avg_ms
    FROM public.api_call_logs l
    JOIN public.video_generation_jobs j ON l.job_id = j.id
    WHERE j.account_id = p_account_id
      AND l.created_at >= p_since
    GROUP BY 1
    ORDER BY 3 DESC;

  ELSIF p_group_by = 'model' THEN
    RETURN QUERY
    SELECT
      (COALESCE(l.provider, 'unknown') || ' · ' || COALESCE(l.model, 'unknown'))::text AS label,
      COUNT(*)::bigint                              AS calls,
      COALESCE(SUM(l.cost), 0)::numeric             AS spend,
      COALESCE(AVG(l.total_duration_ms), 0)::numeric AS avg_ms
    FROM public.api_call_logs l
    JOIN public.video_generation_jobs j ON l.job_id = j.id
    WHERE j.account_id = p_account_id
      AND l.created_at >= p_since
    GROUP BY 1
    ORDER BY 3 DESC;

  ELSIF p_group_by = 'day' THEN
    RETURN QUERY
    SELECT
      to_char(date_trunc('day', l.created_at), 'YYYY-MM-DD')::text AS label,
      COUNT(*)::bigint                              AS calls,
      COALESCE(SUM(l.cost), 0)::numeric             AS spend,
      COALESCE(AVG(l.total_duration_ms), 0)::numeric AS avg_ms
    FROM public.api_call_logs l
    JOIN public.video_generation_jobs j ON l.job_id = j.id
    WHERE j.account_id = p_account_id
      AND l.created_at >= p_since
    GROUP BY date_trunc('day', l.created_at)
    ORDER BY date_trunc('day', l.created_at) DESC;

  ELSE
    RAISE EXCEPTION 'api_spend_breakdown: group_by must be provider, model, or day'
      USING ERRCODE = '22023';
  END IF;
END;
$func$;

REVOKE ALL    ON FUNCTION public.api_spend_breakdown(uuid, timestamptz, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.api_spend_breakdown(uuid, timestamptz, text) TO authenticated;

COMMIT;
