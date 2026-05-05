-- ============================================================
-- Admin rebuild — Phase 3 / 4 / 5: wrapper RPCs over MVs + activity feed
-- ============================================================
-- WHAT: Adds SECURITY DEFINER wrapper RPCs so admin clients can
--       read the (revoked) admin MVs and the unified activity
--       feed via is_admin()-gated entrypoints.
--
-- WHY:  Materialized views can't carry RLS. We REVOKE'd anon/
--       authenticated access on Phase 2.3 MVs and route reads
--       through these RPCs which gate on public.is_admin(auth.uid())
--       at the entry point.
--
-- IMPLEMENTS: ADMIN_REBUILD_CHECKLIST.md sections 3 / 4 / 5.
-- ============================================================

BEGIN;

-- ── 1. admin_overview_snapshot() ─────────────────────────────
-- Single round-trip aggregate for the Overview tab's 6 KPIs +
-- 14-day sparklines.
CREATE OR REPLACE FUNCTION public.admin_overview_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_overview_snapshot: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'active_users_24h',          (SELECT COALESCE(active_users, 0) FROM public.admin_mv_daily_active_users WHERE day = CURRENT_DATE),
    'active_users_yesterday',    (SELECT COALESCE(active_users, 0) FROM public.admin_mv_daily_active_users WHERE day = CURRENT_DATE - 1),
    'active_users_spark',        (SELECT COALESCE(jsonb_agg(active_users ORDER BY day ASC), '[]'::jsonb) FROM (SELECT day, active_users FROM public.admin_mv_daily_active_users WHERE day >= CURRENT_DATE - 13 ORDER BY day DESC LIMIT 14) s),
    'gens_today',                (SELECT COALESCE(SUM(generation_count), 0) FROM public.admin_mv_daily_generation_stats WHERE day = CURRENT_DATE),
    'gens_yesterday',            (SELECT COALESCE(SUM(generation_count), 0) FROM public.admin_mv_daily_generation_stats WHERE day = CURRENT_DATE - 1),
    'gens_spark',                (SELECT COALESCE(jsonb_agg(daily_count ORDER BY day ASC), '[]'::jsonb) FROM (SELECT day, SUM(generation_count) AS daily_count FROM public.admin_mv_daily_generation_stats WHERE day >= CURRENT_DATE - 13 GROUP BY day ORDER BY day DESC LIMIT 14) s),
    'mtd_spend',                 (SELECT COALESCE(SUM(spend), 0) FROM public.admin_mv_api_costs_daily WHERE day >= date_trunc('month', CURRENT_DATE)),
    'mtd_spend_spark',           (SELECT COALESCE(jsonb_agg(daily_spend ORDER BY day ASC), '[]'::jsonb) FROM (SELECT day, SUM(spend) AS daily_spend FROM public.admin_mv_api_costs_daily WHERE day >= CURRENT_DATE - 13 GROUP BY day ORDER BY day DESC LIMIT 14) s),
    -- admin_mv_daily_revenue tracks credit packs sold (transaction_count + total_credits_sold), NOT money. Real Stripe MRR comes from edge fn admin-stats/revenue_stats. We surface credit-pack credits/month as a proxy.
    'mtd_credits_sold',          (SELECT COALESCE(SUM(total_credits_sold), 0) FROM public.admin_mv_daily_revenue WHERE day >= date_trunc('month', CURRENT_DATE)),
    'errors_1h',                 (SELECT COUNT(*) FROM public.system_logs WHERE category = 'system_error' AND created_at > NOW() - INTERVAL '1 hour'),
    'errors_24h_peak',           (SELECT COALESCE(MAX(c), 0) FROM (SELECT date_trunc('hour', created_at) AS hr, COUNT(*) AS c FROM public.system_logs WHERE category = 'system_error' AND created_at > NOW() - INTERVAL '24 hours' GROUP BY 1) hourly),
    'open_tickets',              (SELECT COUNT(*) FROM public.admin_message_threads WHERE status IN ('open','answered'))
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_overview_snapshot() FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_overview_snapshot() TO authenticated;

-- ── 2. admin_overview_cost_split() ───────────────────────────
-- 5-slice donut data for Cost split MTD card.
CREATE OR REPLACE FUNCTION public.admin_overview_cost_split()
RETURNS TABLE (provider text, spend numeric, calls bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_overview_cost_split: forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    m.provider,
    SUM(m.spend)::numeric AS spend,
    SUM(m.calls)::bigint  AS calls
  FROM public.admin_mv_api_costs_daily m
  WHERE m.day >= date_trunc('month', CURRENT_DATE)
  GROUP BY m.provider
  ORDER BY 2 DESC;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_overview_cost_split() FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_overview_cost_split() TO authenticated;

-- ── 3. admin_top_users_by_spend(p_since, p_limit) ────────────
-- Top users by api_call_logs.cost in window. Used by Overview's
-- "Top users · 7d" card and Users tab "Top spenders" sidebar.
CREATE OR REPLACE FUNCTION public.admin_top_users_by_spend(
  p_since timestamptz DEFAULT NOW() - INTERVAL '7 days',
  p_limit int        DEFAULT 5
)
RETURNS TABLE (
  user_id uuid,
  display_name text,
  avatar_url text,
  spend numeric,
  call_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_top_users_by_spend: forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    a.user_id,
    p.display_name,
    p.avatar_url,
    SUM(a.cost)::numeric AS spend,
    COUNT(*)::bigint     AS call_count
  FROM public.api_call_logs a
  LEFT JOIN public.profiles p ON p.user_id = a.user_id
  WHERE a.created_at >= p_since
    AND a.user_id IS NOT NULL
    AND a.cost IS NOT NULL
  GROUP BY a.user_id, p.display_name, p.avatar_url
  ORDER BY 4 DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_top_users_by_spend(timestamptz, int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_top_users_by_spend(timestamptz, int) TO authenticated;

-- ── 4. admin_analytics_kpis() ────────────────────────────────
-- 4-tile snapshot for Analytics tab: DAU today, WAU 7d, MAU 30d,
-- Stickiness (DAU/MAU).
CREATE OR REPLACE FUNCTION public.admin_analytics_kpis()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dau_today int;
  v_dau_yesterday int;
  v_wau int;
  v_mau int;
  v_total_users int;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_analytics_kpis: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(active_users, 0) INTO v_dau_today      FROM public.admin_mv_daily_active_users WHERE day = CURRENT_DATE;
  SELECT COALESCE(active_users, 0) INTO v_dau_yesterday FROM public.admin_mv_daily_active_users WHERE day = CURRENT_DATE - 1;

  SELECT COUNT(DISTINCT user_id) INTO v_wau FROM public.system_logs WHERE category = 'user_activity' AND created_at > NOW() - INTERVAL '7 days';
  SELECT COUNT(DISTINCT user_id) INTO v_mau FROM public.system_logs WHERE category = 'user_activity' AND created_at > NOW() - INTERVAL '30 days';
  SELECT COUNT(*) INTO v_total_users FROM public.profiles WHERE deleted_at IS NULL;

  RETURN jsonb_build_object(
    'dau_today',      COALESCE(v_dau_today, 0),
    'dau_yesterday',  COALESCE(v_dau_yesterday, 0),
    'wau',            COALESCE(v_wau, 0),
    'mau',            COALESCE(v_mau, 0),
    'total_users',    COALESCE(v_total_users, 0),
    'stickiness_pct', CASE WHEN COALESCE(v_mau, 0) > 0 THEN ROUND((v_dau_today::numeric / v_mau::numeric) * 100, 1) ELSE 0 END
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_analytics_kpis() FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_analytics_kpis() TO authenticated;

-- ── 5. admin_analytics_timeseries(p_metric, p_since) ─────────
-- Generic time-series for DAU / signups / generations / revenue.
CREATE OR REPLACE FUNCTION public.admin_analytics_timeseries(
  p_metric text,
  p_since  timestamptz DEFAULT NOW() - INTERVAL '30 days'
)
RETURNS TABLE (day date, value numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_analytics_timeseries: forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_metric = 'dau' THEN
    RETURN QUERY SELECT m.day, m.active_users::numeric FROM public.admin_mv_daily_active_users m WHERE m.day >= p_since::date ORDER BY m.day;
  ELSIF p_metric = 'signups' THEN
    RETURN QUERY SELECT m.day, m.signups::numeric FROM public.admin_mv_daily_signups m WHERE m.day >= p_since::date ORDER BY m.day;
  ELSIF p_metric = 'generations' THEN
    RETURN QUERY SELECT m.day, SUM(m.generation_count)::numeric FROM public.admin_mv_daily_generation_stats m WHERE m.day >= p_since::date GROUP BY m.day ORDER BY m.day;
  ELSIF p_metric = 'credits_sold' THEN
    RETURN QUERY SELECT m.day, m.total_credits_sold::numeric FROM public.admin_mv_daily_revenue m WHERE m.day >= p_since::date ORDER BY m.day;
  ELSIF p_metric = 'spend' THEN
    RETURN QUERY SELECT m.day, SUM(m.spend)::numeric FROM public.admin_mv_api_costs_daily m WHERE m.day >= p_since::date GROUP BY m.day ORDER BY m.day;
  ELSE
    RAISE EXCEPTION 'admin_analytics_timeseries: unknown metric %', p_metric USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_analytics_timeseries(text, timestamptz) FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_analytics_timeseries(text, timestamptz) TO authenticated;

-- ── 6. admin_analytics_plan_mix() ────────────────────────────
-- 3-slice donut: Studio / Pro / Free counts.
CREATE OR REPLACE FUNCTION public.admin_analytics_plan_mix()
RETURNS TABLE (plan_name text, count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_free_count bigint;
  v_studio_count bigint;
  v_pro_count bigint;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_analytics_plan_mix: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_studio_count
  FROM public.subscriptions
  WHERE status IN ('active','trialing')
    AND COALESCE(plan_name, '') ILIKE '%studio%';

  SELECT COUNT(*) INTO v_pro_count
  FROM public.subscriptions
  WHERE status IN ('active','trialing')
    AND COALESCE(plan_name, '') ILIKE '%pro%'
    AND COALESCE(plan_name, '') NOT ILIKE '%studio%';

  SELECT COUNT(*) INTO v_free_count
  FROM public.profiles p
  WHERE p.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.subscriptions s
      WHERE s.user_id = p.user_id
        AND s.status IN ('active','trialing')
        AND COALESCE(s.plan_name, '') !~* 'free'
    );

  RETURN QUERY
  SELECT 'Studio'::text, v_studio_count
  UNION ALL SELECT 'Pro'::text, v_pro_count
  UNION ALL SELECT 'Free'::text, v_free_count;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_analytics_plan_mix() FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_analytics_plan_mix() TO authenticated;

-- ── 7. admin_analytics_funnel(p_since) ───────────────────────
-- 6-stage funnel: visited (proxy = signed up) → started signup
-- → completed signup → first gen → returned next day → upgraded.
-- "Visited" landing page is not tracked DB-side; we use signup
-- count as the funnel base for now (real top-of-funnel needs a
-- visit-tracking table not yet built).
CREATE OR REPLACE FUNCTION public.admin_analytics_funnel(
  p_since timestamptz DEFAULT NOW() - INTERVAL '30 days'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_signups int;
  v_first_project int;
  v_first_gen int;
  v_returned int;
  v_paid int;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_analytics_funnel: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_signups FROM auth.users WHERE created_at >= p_since;

  SELECT COUNT(DISTINCT u.id) INTO v_first_project
  FROM auth.users u
  WHERE u.created_at >= p_since
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.user_id = u.id);

  SELECT COUNT(DISTINCT u.id) INTO v_first_gen
  FROM auth.users u
  WHERE u.created_at >= p_since
    AND EXISTS (SELECT 1 FROM public.generations g WHERE g.user_id = u.id);

  SELECT COUNT(DISTINCT u.id) INTO v_returned
  FROM auth.users u
  WHERE u.created_at >= p_since
    AND EXISTS (
      SELECT 1 FROM public.system_logs sl
      WHERE sl.user_id = u.id
        AND sl.category = 'user_activity'
        AND sl.created_at >= u.created_at + INTERVAL '1 day'
        AND sl.created_at <  u.created_at + INTERVAL '2 days'
    );

  SELECT COUNT(DISTINCT u.id) INTO v_paid
  FROM auth.users u
  WHERE u.created_at >= p_since
    AND EXISTS (
      SELECT 1 FROM public.subscriptions s
      WHERE s.user_id = u.id
        AND s.status IN ('active','trialing')
        AND COALESCE(s.plan_name, '') !~* 'free'
    );

  RETURN jsonb_build_object(
    'signups',        COALESCE(v_signups, 0),
    'first_project',  COALESCE(v_first_project, 0),
    'first_gen',      COALESCE(v_first_gen, 0),
    'returned',       COALESCE(v_returned, 0),
    'paid',           COALESCE(v_paid, 0)
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_analytics_funnel(timestamptz) FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_analytics_funnel(timestamptz) TO authenticated;

-- ── 8. admin_analytics_cohort_retention() ────────────────────
-- Returns up to last 6 weekly cohorts × W0..W8 retention pct.
-- A row is one cohort with an array of 9 percentages [W0..W8].
CREATE OR REPLACE FUNCTION public.admin_analytics_cohort_retention()
RETURNS TABLE (
  cohort_week date,
  cohort_size int,
  retention numeric[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rec RECORD;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_analytics_cohort_retention: forbidden' USING ERRCODE = '42501';
  END IF;

  FOR rec IN
    SELECT date_trunc('week', u.created_at)::date AS cw, COUNT(*)::int AS sz
    FROM auth.users u
    WHERE u.created_at >= NOW() - INTERVAL '60 days'
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT 6
  LOOP
    cohort_week := rec.cw;
    cohort_size := rec.sz;
    retention := ARRAY(
      SELECT
        CASE WHEN rec.sz = 0 THEN 0
        ELSE ROUND(
          (
            COUNT(DISTINCT u.id)::numeric / rec.sz::numeric
          ) * 100, 0
        )
        END
      FROM generate_series(0, 8) week_offset
      LEFT JOIN auth.users u
        ON date_trunc('week', u.created_at)::date = rec.cw
        AND EXISTS (
          SELECT 1 FROM public.system_logs sl
          WHERE sl.user_id = u.id
            AND sl.category = 'user_activity'
            AND sl.created_at >= rec.cw + (week_offset || ' weeks')::interval
            AND sl.created_at <  rec.cw + ((week_offset+1) || ' weeks')::interval
        )
      GROUP BY week_offset
      ORDER BY week_offset
    );
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_analytics_cohort_retention() FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_analytics_cohort_retention() TO authenticated;

-- ── 9. admin_analytics_project_type_mix() ────────────────────
-- Surfaces the project_type MV.
CREATE OR REPLACE FUNCTION public.admin_analytics_project_type_mix()
RETURNS TABLE (project_type text, count int, last_7d int, last_30d int)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_analytics_project_type_mix: forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT m.project_type, m.count, m.last_7d, m.last_30d
  FROM public.admin_mv_project_type_mix m
  ORDER BY m.count DESC;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_analytics_project_type_mix() FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_analytics_project_type_mix() TO authenticated;

-- ── 10. admin_activity_feed(p_since, p_user_id, p_event_types, p_limit) ──
-- Unified activity feed used by the Overview tab's left card and
-- the Activity tab's full feed. UNIONs admin_logs + system_logs +
-- credit_transactions into a normalized shape.
CREATE OR REPLACE FUNCTION public.admin_activity_feed(
  p_since        timestamptz DEFAULT NOW() - INTERVAL '24 hours',
  p_user_id      uuid        DEFAULT NULL,
  p_event_types  text[]      DEFAULT NULL,
  p_limit        int         DEFAULT 100
)
RETURNS TABLE (
  id           text,
  source       text,         -- 'system' | 'admin' | 'credit'
  event_type   text,
  category     text,
  user_id      uuid,
  message      text,
  details      jsonb,
  generation_id uuid,
  project_id    uuid,
  created_at   timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_activity_feed: forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH unified AS (
    -- system_logs
    SELECT
      sl.id::text                                   AS id,
      'system'::text                                AS source,
      sl.event_type                                 AS event_type,
      sl.category                                   AS category,
      sl.user_id                                    AS user_id,
      COALESCE(sl.message, sl.event_type)           AS message,
      COALESCE(sl.details, '{}'::jsonb)             AS details,
      sl.generation_id                              AS generation_id,
      sl.project_id                                 AS project_id,
      sl.created_at                                 AS created_at
    FROM public.system_logs sl
    WHERE sl.created_at >= p_since
      AND (p_user_id IS NULL OR sl.user_id = p_user_id)
      AND (p_event_types IS NULL OR sl.event_type = ANY(p_event_types))

    UNION ALL

    -- admin_logs
    SELECT
      al.id::text                                                                     AS id,
      'admin'::text                                                                   AS source,
      al.action                                                                       AS event_type,
      'admin_action'::text                                                            AS category,
      COALESCE((al.details ->> 'target_user_id')::uuid, al.admin_id)                  AS user_id,
      COALESCE(al.action, 'admin action') || ' on ' || COALESCE(al.target_type, '?')  AS message,
      COALESCE(al.details, '{}'::jsonb)                                               AS details,
      NULL::uuid                                                                      AS generation_id,
      NULL::uuid                                                                      AS project_id,
      al.created_at                                                                   AS created_at
    FROM public.admin_logs al
    WHERE al.created_at >= p_since
      AND (p_user_id IS NULL OR (al.details ->> 'target_user_id')::uuid = p_user_id OR al.admin_id = p_user_id)

    UNION ALL

    -- credit_transactions (synthetic projection)
    SELECT
      ct.id::text                                                                  AS id,
      'credit'::text                                                                AS source,
      ('pay.' || ct.transaction_type)::text                                         AS event_type,
      'system_info'::text                                                           AS category,
      ct.user_id                                                                    AS user_id,
      ct.transaction_type || ' ' || ABS(ct.amount)::text || ' credits'              AS message,
      jsonb_build_object('amount', ct.amount, 'description', ct.description)        AS details,
      NULL::uuid                                                                    AS generation_id,
      NULL::uuid                                                                    AS project_id,
      ct.created_at                                                                 AS created_at
    FROM public.credit_transactions ct
    WHERE ct.created_at >= p_since
      AND (p_user_id IS NULL OR ct.user_id = p_user_id)
  )
  SELECT *
  FROM unified
  ORDER BY created_at DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_activity_feed(timestamptz, uuid, text[], int) FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_activity_feed(timestamptz, uuid, text[], int) TO authenticated;

COMMIT;
