-- ============================================================
-- Admin rebuild — Phase 6 (API & Costs) + Phase 7 (API Keys)
-- ============================================================
-- WHAT:
--   Phase 6: SECURITY DEFINER wrappers over api_call_logs +
--     admin_mv_api_costs_daily for the API & Costs tab.
--   Phase 7: internal_api_keys + webhook_events_summary tables,
--     plus RPCs for create / rotate / revoke / list keys.
--
-- WHY:  The API & Costs tab needs aggregate breakdowns and a
--   top-N expensive-calls list. The API Keys tab manages
--   server-issued tokens (mm_live_… / mm_test_…) and their
--   audit trail.
--
-- IMPLEMENTS: ADMIN_REBUILD_CHECKLIST.md sections 6, 7.
-- ============================================================

BEGIN;

-- ── Phase 6: API & Costs RPCs ────────────────────────────────

-- 1. admin_api_cost_kpis()
-- Returns a single jsonb with the 4 tile values:
--   api_calls_30d, api_spend_mtd, p95_latency_ms_30d, error_rate_30d.
CREATE OR REPLACE FUNCTION public.admin_api_cost_kpis()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_api_cost_kpis: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'api_calls_30d',       (SELECT COALESCE(SUM(calls), 0)::bigint FROM public.admin_mv_api_costs_daily WHERE day >= CURRENT_DATE - 30),
    'api_calls_prev_30d',  (SELECT COALESCE(SUM(calls), 0)::bigint FROM public.admin_mv_api_costs_daily WHERE day >= CURRENT_DATE - 60 AND day <  CURRENT_DATE - 30),
    'api_spend_mtd',       (SELECT COALESCE(SUM(spend), 0)::numeric FROM public.admin_mv_api_costs_daily WHERE day >= date_trunc('month', CURRENT_DATE)),
    'api_spend_prev_mtd',  (SELECT COALESCE(SUM(spend), 0)::numeric FROM public.admin_mv_api_costs_daily WHERE day >= (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month') AND day < date_trunc('month', CURRENT_DATE)),
    'avg_cost_per_gen',    (SELECT CASE WHEN COUNT(DISTINCT generation_id) > 0 THEN ROUND((SUM(cost) / COUNT(DISTINCT generation_id))::numeric, 4) ELSE 0 END FROM public.api_call_logs WHERE created_at > NOW() - INTERVAL '30 days' AND generation_id IS NOT NULL AND cost IS NOT NULL),
    'p95_latency_ms_30d',  (SELECT COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration_ms), 0)::int FROM public.api_call_logs WHERE created_at > NOW() - INTERVAL '30 days' AND total_duration_ms IS NOT NULL),
    'p95_latency_prev_30d',(SELECT COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration_ms), 0)::int FROM public.api_call_logs WHERE created_at > NOW() - INTERVAL '60 days' AND created_at <= NOW() - INTERVAL '30 days' AND total_duration_ms IS NOT NULL),
    'error_rate_30d',      (SELECT CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE status = 'error')::numeric / COUNT(*)::numeric * 100, 2) ELSE 0 END FROM public.api_call_logs WHERE created_at > NOW() - INTERVAL '30 days')
  )
  INTO v;
  RETURN v;
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_api_cost_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_api_cost_kpis() TO authenticated;

-- 2. admin_api_cost_breakdown(p_since, p_group_by)
-- Replaces the legacy get_generation_costs_summary(). Aggregates
-- api_call_logs by provider/model/user/task_type/day/week.
CREATE OR REPLACE FUNCTION public.admin_api_cost_breakdown(
  p_since   timestamptz DEFAULT NOW() - INTERVAL '30 days',
  p_group_by text       DEFAULT 'provider'
)
RETURNS TABLE (
  label   text,
  calls   bigint,
  spend   numeric,
  avg_ms  numeric,
  err_pct numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_api_cost_breakdown: forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_group_by = 'provider' THEN
    RETURN QUERY
    SELECT
      COALESCE(a.provider, 'unknown')::text                                                                       AS label,
      COUNT(*)::bigint                                                                                            AS calls,
      COALESCE(SUM(a.cost), 0)::numeric                                                                           AS spend,
      COALESCE(AVG(a.total_duration_ms), 0)::numeric                                                              AS avg_ms,
      CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE a.status = 'error')::numeric / COUNT(*)::numeric * 100, 2) ELSE 0 END AS err_pct
    FROM public.api_call_logs a
    WHERE a.created_at >= p_since
    GROUP BY 1
    ORDER BY 3 DESC;
  ELSIF p_group_by = 'model' THEN
    RETURN QUERY
    SELECT
      (COALESCE(a.provider, 'unknown') || ' · ' || COALESCE(a.model, 'unknown'))::text                            AS label,
      COUNT(*)::bigint                                                                                            AS calls,
      COALESCE(SUM(a.cost), 0)::numeric                                                                           AS spend,
      COALESCE(AVG(a.total_duration_ms), 0)::numeric                                                              AS avg_ms,
      CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE a.status = 'error')::numeric / COUNT(*)::numeric * 100, 2) ELSE 0 END
    FROM public.api_call_logs a
    WHERE a.created_at >= p_since
    GROUP BY 1
    ORDER BY 3 DESC;
  ELSIF p_group_by = 'user' THEN
    RETURN QUERY
    SELECT
      COALESCE(a.user_id::text, 'system')                                                                         AS label,
      COUNT(*)::bigint,
      COALESCE(SUM(a.cost), 0)::numeric,
      COALESCE(AVG(a.total_duration_ms), 0)::numeric,
      CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE a.status = 'error')::numeric / COUNT(*)::numeric * 100, 2) ELSE 0 END
    FROM public.api_call_logs a
    WHERE a.created_at >= p_since
    GROUP BY 1
    ORDER BY 3 DESC
    LIMIT 50;
  ELSIF p_group_by = 'day' THEN
    RETURN QUERY
    SELECT
      to_char(date_trunc('day', a.created_at), 'YYYY-MM-DD')                                                      AS label,
      COUNT(*)::bigint,
      COALESCE(SUM(a.cost), 0)::numeric,
      COALESCE(AVG(a.total_duration_ms), 0)::numeric,
      CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE a.status = 'error')::numeric / COUNT(*)::numeric * 100, 2) ELSE 0 END
    FROM public.api_call_logs a
    WHERE a.created_at >= p_since
    GROUP BY 1
    ORDER BY 1;
  ELSE
    RAISE EXCEPTION 'admin_api_cost_breakdown: unknown group_by %', p_group_by USING ERRCODE = '22023';
  END IF;
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_api_cost_breakdown(timestamptz, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_api_cost_breakdown(timestamptz, text) TO authenticated;

-- 3. admin_top_expensive_calls(p_since, p_limit)
CREATE OR REPLACE FUNCTION public.admin_top_expensive_calls(
  p_since timestamptz DEFAULT NOW() - INTERVAL '7 days',
  p_limit int DEFAULT 20
)
RETURNS TABLE (
  id            uuid,
  user_id       uuid,
  generation_id uuid,
  provider      text,
  model         text,
  status        text,
  cost          numeric,
  duration_ms   integer,
  created_at    timestamptz,
  error_message text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_top_expensive_calls: forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT a.id, a.user_id, a.generation_id, a.provider, a.model, a.status,
         a.cost, a.total_duration_ms, a.created_at, a.error_message
  FROM public.api_call_logs a
  WHERE a.created_at >= p_since
    AND a.cost IS NOT NULL
  ORDER BY a.cost DESC NULLS LAST
  LIMIT p_limit;
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_top_expensive_calls(timestamptz, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_top_expensive_calls(timestamptz, int) TO authenticated;

-- 4. admin_api_calls_weekly()
-- 14-day daily totals for the "API calls · weekly" bar chart.
CREATE OR REPLACE FUNCTION public.admin_api_calls_weekly()
RETURNS TABLE (day date, calls bigint, spend numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_api_calls_weekly: forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    m.day,
    SUM(m.calls)::bigint AS calls,
    SUM(m.spend)::numeric AS spend
  FROM public.admin_mv_api_costs_daily m
  WHERE m.day >= CURRENT_DATE - 13
  GROUP BY m.day
  ORDER BY m.day;
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_api_calls_weekly() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_api_calls_weekly() TO authenticated;


-- ── Phase 7: API Keys backend ────────────────────────────────

-- 5. internal_api_keys table
-- Server-issued tokens used by edge fns / worker / external services.
-- Tokens are hashed (sha-256); only `prefix` (first 12 chars) is shown
-- to admins for identification. Plaintext is returned exactly ONCE
-- on creation/rotation via the RPC.
CREATE TABLE IF NOT EXISTS public.internal_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  scope        text[] NOT NULL DEFAULT '{}'::text[],
  token_hash   text NOT NULL,
  prefix       text NOT NULL,                                 -- first 12 chars, displayed publicly
  created_by   uuid NOT NULL REFERENCES auth.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz,
  last_used_at timestamptz,
  calls_count  bigint NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','rotated','revoked')),
  notes        text
);

CREATE UNIQUE INDEX IF NOT EXISTS internal_api_keys_token_hash_idx
  ON public.internal_api_keys (token_hash);

CREATE INDEX IF NOT EXISTS internal_api_keys_status_idx
  ON public.internal_api_keys (status);

ALTER TABLE public.internal_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_api_keys FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS iak_admin_select ON public.internal_api_keys;
DROP POLICY IF EXISTS iak_service_role_all ON public.internal_api_keys;
DROP POLICY IF EXISTS iak_deny_anon ON public.internal_api_keys;

CREATE POLICY iak_admin_select ON public.internal_api_keys FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY iak_service_role_all ON public.internal_api_keys FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY iak_deny_anon ON public.internal_api_keys AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- 6. internal_api_key_events — audit trail
CREATE TABLE IF NOT EXISTS public.internal_api_key_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      uuid NOT NULL REFERENCES public.internal_api_keys(id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN ('created','used','rotated','revoked','renamed')),
  actor_id    uuid REFERENCES auth.users(id),
  ip_address  text,
  user_agent  text,
  details     jsonb DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS internal_api_key_events_key_id_created_at_idx
  ON public.internal_api_key_events (key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS internal_api_key_events_action_created_at_idx
  ON public.internal_api_key_events (action, created_at DESC);

ALTER TABLE public.internal_api_key_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_api_key_events FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS iake_admin_select ON public.internal_api_key_events;
DROP POLICY IF EXISTS iake_service_role_all ON public.internal_api_key_events;
DROP POLICY IF EXISTS iake_deny_anon ON public.internal_api_key_events;

CREATE POLICY iake_admin_select ON public.internal_api_key_events FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY iake_service_role_all ON public.internal_api_key_events FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY iake_deny_anon ON public.internal_api_key_events AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- 7. webhooks table — outbound webhook registry
CREATE TABLE IF NOT EXISTS public.admin_webhooks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url             text NOT NULL,
  events          text[] NOT NULL DEFAULT '{}'::text[],
  secret_hash     text,                                         -- HMAC secret hash; NULL = no signing
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled')),
  last_delivery_at timestamptz,
  success_24h     int NOT NULL DEFAULT 0,
  error_24h       int NOT NULL DEFAULT 0,
  created_by      uuid NOT NULL REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  notes           text
);

CREATE INDEX IF NOT EXISTS admin_webhooks_status_idx ON public.admin_webhooks (status);

ALTER TABLE public.admin_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_webhooks FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aw_admin_select ON public.admin_webhooks;
DROP POLICY IF EXISTS aw_service_role_all ON public.admin_webhooks;
DROP POLICY IF EXISTS aw_deny_anon ON public.admin_webhooks;

CREATE POLICY aw_admin_select ON public.admin_webhooks FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY aw_service_role_all ON public.admin_webhooks FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY aw_deny_anon ON public.admin_webhooks AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- 8. admin_create_internal_key(p_name, p_scope, p_notes)
-- Generates a new mm_live_… token, returns plaintext ONCE, stores
-- only the sha-256 hash. The prefix (first 12 chars) is kept in
-- plaintext for admin display. Audit-logged in admin_logs.
CREATE OR REPLACE FUNCTION public.admin_create_internal_key(
  p_name  text,
  p_scope text[] DEFAULT '{}'::text[],
  p_notes text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_admin_id uuid := auth.uid();
  v_token    text;
  v_hash     text;
  v_prefix   text;
  v_id       uuid;
BEGIN
  IF v_admin_id IS NULL OR NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_create_internal_key: forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'admin_create_internal_key: name required' USING ERRCODE = '22023';
  END IF;

  -- Token: mm_live_<32 base64-url chars>. Service role uses pgcrypto.
  v_token  := 'mm_live_' || encode(gen_random_bytes(24), 'base64');
  v_token  := replace(replace(replace(v_token, '/', '_'), '+', '-'), '=', '');
  v_prefix := substring(v_token from 1 for 12);
  v_hash   := encode(digest(v_token, 'sha256'), 'hex');

  INSERT INTO public.internal_api_keys (name, scope, token_hash, prefix, created_by, notes)
  VALUES (trim(p_name), COALESCE(p_scope, '{}'), v_hash, v_prefix, v_admin_id, p_notes)
  RETURNING id INTO v_id;

  INSERT INTO public.internal_api_key_events (key_id, action, actor_id, details)
  VALUES (v_id, 'created', v_admin_id, jsonb_build_object('name', p_name, 'scope', p_scope));

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin_id, 'internal_api_key_created', 'internal_api_key', v_id,
          jsonb_build_object('name', p_name, 'scope', p_scope, 'prefix', v_prefix));

  RETURN jsonb_build_object('id', v_id, 'token', v_token, 'prefix', v_prefix);
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_create_internal_key(text, text[], text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_create_internal_key(text, text[], text) TO authenticated;

-- 9. admin_rotate_internal_key(p_id) — issues new token, marks old rotated.
CREATE OR REPLACE FUNCTION public.admin_rotate_internal_key(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_admin_id uuid := auth.uid();
  v_token    text;
  v_hash     text;
  v_prefix   text;
  v_old      RECORD;
BEGIN
  IF v_admin_id IS NULL OR NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_rotate_internal_key: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT id, name, status, scope, prefix
    INTO v_old
    FROM public.internal_api_keys
   WHERE id = p_id
   FOR UPDATE;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'admin_rotate_internal_key: key not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_old.status = 'revoked' THEN
    RAISE EXCEPTION 'admin_rotate_internal_key: key is revoked' USING ERRCODE = '22023';
  END IF;

  v_token  := 'mm_live_' || encode(gen_random_bytes(24), 'base64');
  v_token  := replace(replace(replace(v_token, '/', '_'), '+', '-'), '=', '');
  v_prefix := substring(v_token from 1 for 12);
  v_hash   := encode(digest(v_token, 'sha256'), 'hex');

  UPDATE public.internal_api_keys
     SET token_hash = v_hash, prefix = v_prefix, rotated_at = NOW()
   WHERE id = p_id;

  INSERT INTO public.internal_api_key_events (key_id, action, actor_id, details)
  VALUES (p_id, 'rotated', v_admin_id, jsonb_build_object('old_prefix', v_old.prefix, 'new_prefix', v_prefix));

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin_id, 'internal_api_key_rotated', 'internal_api_key', p_id,
          jsonb_build_object('old_prefix', v_old.prefix, 'new_prefix', v_prefix));

  RETURN jsonb_build_object('id', p_id, 'token', v_token, 'prefix', v_prefix);
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_rotate_internal_key(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_rotate_internal_key(uuid) TO authenticated;

-- 10. admin_revoke_internal_key(p_id, p_reason)
CREATE OR REPLACE FUNCTION public.admin_revoke_internal_key(p_id uuid, p_reason text DEFAULT 'admin revoke')
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_admin_id uuid := auth.uid();
  v_old RECORD;
BEGIN
  IF v_admin_id IS NULL OR NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_revoke_internal_key: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT id, status, prefix INTO v_old FROM public.internal_api_keys WHERE id = p_id FOR UPDATE;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'admin_revoke_internal_key: key not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.internal_api_keys
     SET status = 'revoked'
   WHERE id = p_id;

  INSERT INTO public.internal_api_key_events (key_id, action, actor_id, details)
  VALUES (p_id, 'revoked', v_admin_id, jsonb_build_object('reason', p_reason, 'prefix', v_old.prefix));

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin_id, 'internal_api_key_revoked', 'internal_api_key', p_id,
          jsonb_build_object('reason', p_reason, 'prefix', v_old.prefix));

  RETURN jsonb_build_object('id', p_id, 'status', 'revoked');
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_revoke_internal_key(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_internal_key(uuid, text) TO authenticated;

-- 11. admin_api_keys_kpis()
CREATE OR REPLACE FUNCTION public.admin_api_keys_kpis()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_api_keys_kpis: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'active_keys',          (SELECT COUNT(*) FROM public.internal_api_keys WHERE status = 'active'),
    'rotated_keys',         (SELECT COUNT(*) FROM public.internal_api_keys WHERE status = 'rotated'),
    'revoked_keys',         (SELECT COUNT(*) FROM public.internal_api_keys WHERE status = 'revoked'),
    'calls_24h',            (SELECT COALESCE(SUM(calls_count), 0)::bigint FROM public.internal_api_keys WHERE last_used_at > NOW() - INTERVAL '24 hours'),
    'last_rotation_at',     (SELECT MAX(rotated_at) FROM public.internal_api_keys),
    'webhook_count',        (SELECT COUNT(*) FROM public.admin_webhooks WHERE status = 'active'),
    'provider_keys_active', (SELECT COUNT(*) FROM public.user_provider_keys WHERE status = 'active'),
    'provider_keys_disabled',(SELECT COUNT(*) FROM public.user_provider_keys WHERE status = 'disabled'),
    'recent_creations_7d',  (SELECT COUNT(*) FROM public.internal_api_key_events WHERE action = 'created' AND created_at > NOW() - INTERVAL '7 days')
  )
  INTO v;
  RETURN v;
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_api_keys_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_api_keys_kpis() TO authenticated;

COMMIT;
