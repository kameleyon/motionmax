-- ============================================================
-- Admin rebuild — Phase 8 (Users) + 9 (Generations) + 10 (Performance)
-- ============================================================

BEGIN;

-- ============================================================
-- Phase 8: Users tab
-- ============================================================

-- 1. admin_users_kpis()
CREATE OR REPLACE FUNCTION public.admin_users_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_users_kpis: forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'total_users',     (SELECT COUNT(*) FROM public.profiles WHERE deleted_at IS NULL),
    'signups_7d',      (SELECT COUNT(*) FROM auth.users WHERE created_at > NOW() - INTERVAL '7 days'),
    'paying_users',    (SELECT COUNT(DISTINCT user_id) FROM public.subscriptions WHERE status IN ('active','trialing') AND COALESCE(plan_name, '') !~* 'free'),
    'studio_users',    (SELECT COUNT(*) FROM public.subscriptions WHERE status IN ('active','trialing') AND COALESCE(plan_name, '') ILIKE '%studio%'),
    'studio_delta_7d', (SELECT COUNT(*) FROM public.subscriptions WHERE COALESCE(plan_name, '') ILIKE '%studio%' AND created_at > NOW() - INTERVAL '7 days'),
    'flagged',         (SELECT COUNT(DISTINCT user_id) FROM public.user_flags WHERE resolved_at IS NULL),
    'flagged_auto',    (SELECT COUNT(DISTINCT user_id) FROM public.user_flags WHERE resolved_at IS NULL AND COALESCE(flag_type,'') ILIKE 'auto%'),
    'flagged_manual',  (SELECT COUNT(DISTINCT user_id) FROM public.user_flags WHERE resolved_at IS NULL AND COALESCE(flag_type,'') NOT ILIKE 'auto%')
  ) INTO v;
  RETURN v;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_users_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_users_kpis() TO authenticated;

-- 2. admin_users_list(p_search, p_plan, p_status, p_flag_state, p_page, p_limit)
CREATE OR REPLACE FUNCTION public.admin_users_list(
  p_search     text DEFAULT NULL,
  p_plan       text DEFAULT NULL,    -- 'studio'|'pro'|'free'|'all'
  p_status     text DEFAULT NULL,    -- 'active'|'flagged'|'paused'|'all'
  p_flag_state text DEFAULT NULL,    -- 'open'|'resolved'|'all'
  p_page       int  DEFAULT 1,
  p_limit      int  DEFAULT 50
)
RETURNS TABLE (
  user_id uuid, display_name text, avatar_url text, plan_name text,
  status text, last_sign_in timestamptz, last_active_at timestamptz,
  generations bigint, lifetime_spent numeric, credits_balance int,
  errors_24h bigint, country text, joined timestamptz, total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_total bigint;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_users_list: forbidden' USING ERRCODE = '42501';
  END IF;

  WITH base AS (
    SELECT
      p.user_id,
      p.display_name,
      p.avatar_url,
      p.last_active_at,
      p.created_at AS joined,
      au.last_sign_in_at AS last_sign_in,
      COALESCE(au.raw_user_meta_data->>'country', '') AS country,
      au.email,
      s.plan_name,
      s.status AS sub_status,
      uc.credits_balance,
      uc.total_purchased,
      EXISTS (SELECT 1 FROM public.user_flags f WHERE f.user_id = p.user_id AND f.resolved_at IS NULL) AS has_flag
    FROM public.profiles p
    LEFT JOIN auth.users au ON au.id = p.user_id
    LEFT JOIN public.subscriptions s ON s.user_id = p.user_id AND s.status IN ('active','trialing')
    LEFT JOIN public.user_credits uc ON uc.user_id = p.user_id
    WHERE p.deleted_at IS NULL
  ),
  filtered AS (
    SELECT b.* FROM base b
    WHERE
      (p_search IS NULL OR p_search = '' OR
        b.display_name ILIKE '%' || p_search || '%' OR
        b.email        ILIKE '%' || p_search || '%' OR
        b.user_id::text = p_search)
      AND (p_plan IS NULL OR p_plan IN ('all','') OR
        (p_plan = 'studio' AND COALESCE(b.plan_name,'') ILIKE '%studio%') OR
        (p_plan = 'pro'    AND COALESCE(b.plan_name,'') ILIKE '%pro%' AND COALESCE(b.plan_name,'') NOT ILIKE '%studio%') OR
        (p_plan = 'free'   AND (b.plan_name IS NULL OR COALESCE(b.plan_name,'') ILIKE '%free%')))
      AND (p_status IS NULL OR p_status IN ('all','') OR
        (p_status = 'active'  AND NOT b.has_flag) OR
        (p_status = 'flagged' AND b.has_flag))
  )
  SELECT COUNT(*) INTO v_total FROM filtered;

  RETURN QUERY
  WITH base AS (
    SELECT
      p.user_id,
      p.display_name,
      p.avatar_url,
      p.last_active_at,
      p.created_at AS joined,
      au.last_sign_in_at AS last_sign_in,
      COALESCE(au.raw_user_meta_data->>'country', '') AS country,
      au.email,
      s.plan_name,
      s.status AS sub_status,
      uc.credits_balance,
      uc.total_purchased,
      EXISTS (SELECT 1 FROM public.user_flags f WHERE f.user_id = p.user_id AND f.resolved_at IS NULL) AS has_flag
    FROM public.profiles p
    LEFT JOIN auth.users au ON au.id = p.user_id
    LEFT JOIN public.subscriptions s ON s.user_id = p.user_id AND s.status IN ('active','trialing')
    LEFT JOIN public.user_credits uc ON uc.user_id = p.user_id
    WHERE p.deleted_at IS NULL
  ),
  filtered AS (
    SELECT b.* FROM base b
    WHERE
      (p_search IS NULL OR p_search = '' OR
        b.display_name ILIKE '%' || p_search || '%' OR
        b.email        ILIKE '%' || p_search || '%' OR
        b.user_id::text = p_search)
      AND (p_plan IS NULL OR p_plan IN ('all','') OR
        (p_plan = 'studio' AND COALESCE(b.plan_name,'') ILIKE '%studio%') OR
        (p_plan = 'pro'    AND COALESCE(b.plan_name,'') ILIKE '%pro%' AND COALESCE(b.plan_name,'') NOT ILIKE '%studio%') OR
        (p_plan = 'free'   AND (b.plan_name IS NULL OR COALESCE(b.plan_name,'') ILIKE '%free%')))
      AND (p_status IS NULL OR p_status IN ('all','') OR
        (p_status = 'active'  AND NOT b.has_flag) OR
        (p_status = 'flagged' AND b.has_flag))
  )
  SELECT
    f.user_id,
    f.display_name,
    f.avatar_url,
    f.plan_name,
    CASE WHEN f.has_flag THEN 'flagged' ELSE 'active' END AS status,
    f.last_sign_in,
    f.last_active_at,
    COALESCE((SELECT COUNT(*) FROM public.generations g WHERE g.user_id = f.user_id), 0)::bigint AS generations,
    COALESCE(f.total_purchased, 0)::numeric AS lifetime_spent,
    COALESCE(f.credits_balance, 0)::int AS credits_balance,
    COALESCE((SELECT COUNT(*) FROM public.system_logs sl WHERE sl.user_id = f.user_id AND sl.category = 'system_error' AND sl.created_at > NOW() - INTERVAL '24 hours'), 0)::bigint AS errors_24h,
    f.country,
    f.joined,
    v_total
  FROM filtered f
  ORDER BY COALESCE(f.last_active_at, f.last_sign_in, f.joined) DESC NULLS LAST
  LIMIT GREATEST(p_limit, 1)
  OFFSET GREATEST(p_page - 1, 0) * GREATEST(p_limit, 1);
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_users_list(text, text, text, text, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_users_list(text, text, text, text, int, int) TO authenticated;

-- 3. admin_user_full_detail(p_user_id)
CREATE OR REPLACE FUNCTION public.admin_user_full_detail(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_user_full_detail: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'profile', (SELECT to_jsonb(p) FROM public.profiles p WHERE p.user_id = p_user_id),
    'auth', (SELECT jsonb_build_object('email', au.email, 'created_at', au.created_at, 'last_sign_in_at', au.last_sign_in_at, 'country', au.raw_user_meta_data->>'country') FROM auth.users au WHERE au.id = p_user_id),
    'subscription', (SELECT to_jsonb(s) FROM public.subscriptions s WHERE s.user_id = p_user_id ORDER BY s.created_at DESC LIMIT 1),
    'credits', (SELECT to_jsonb(uc) FROM public.user_credits uc WHERE uc.user_id = p_user_id),
    'flags_open', (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.created_at DESC), '[]'::jsonb) FROM public.user_flags f WHERE f.user_id = p_user_id AND f.resolved_at IS NULL),
    'recent_generations', (SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.created_at DESC), '[]'::jsonb) FROM (SELECT id, project_id, status, created_at FROM public.generations WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT 20) g),
    'recent_transactions', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) FROM (SELECT id, amount, transaction_type, description, created_at FROM public.credit_transactions WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT 20) t),
    'usage_14d', (SELECT COALESCE(jsonb_agg(daily ORDER BY day), '[]'::jsonb) FROM (SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS daily FROM public.generations WHERE user_id = p_user_id AND created_at > NOW() - INTERVAL '14 days' GROUP BY 1 ORDER BY 1) g),
    'errors_24h', (SELECT COUNT(*)::int FROM public.system_logs WHERE user_id = p_user_id AND category = 'system_error' AND created_at > NOW() - INTERVAL '24 hours'),
    'total_generations', (SELECT COUNT(*)::int FROM public.generations WHERE user_id = p_user_id)
  ) INTO v;
  RETURN v;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_user_full_detail(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_user_full_detail(uuid) TO authenticated;

-- 4. admin_set_user_status(p_user_id, p_status, p_reason) — Pause / Restore via user_flags
CREATE OR REPLACE FUNCTION public.admin_set_user_status(
  p_user_id uuid, p_status text, p_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_set_user_status: forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('active','paused') THEN
    RAISE EXCEPTION 'admin_set_user_status: status must be active|paused' USING ERRCODE = '22023';
  END IF;

  IF p_status = 'paused' THEN
    INSERT INTO public.user_flags (user_id, flag_type, reason, flagged_by, details)
    VALUES (p_user_id, 'admin_pause', COALESCE(p_reason, 'Paused by admin'), v_admin, jsonb_build_object('source','admin_set_user_status'));
  ELSE
    UPDATE public.user_flags
       SET resolved_at = NOW(), resolved_by = v_admin, resolution_notes = 'Restored by admin'
     WHERE user_id = p_user_id AND resolved_at IS NULL AND flag_type = 'admin_pause';
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'user_status_set', 'user', p_user_id, jsonb_build_object('status', p_status, 'reason', p_reason));

  RETURN jsonb_build_object('user_id', p_user_id, 'status', p_status);
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_set_user_status(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_status(uuid, text, text) TO authenticated;

-- 5. admin_bulk_grant_credits / admin_bulk_suspend
CREATE OR REPLACE FUNCTION public.admin_bulk_grant_credits(
  p_user_ids uuid[], p_amount int, p_reason text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_uid uuid; v_count int := 0;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_bulk_grant_credits: forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'admin_bulk_grant_credits: amount must be > 0' USING ERRCODE = '22023';
  END IF;
  FOREACH v_uid IN ARRAY p_user_ids LOOP
    PERFORM public.admin_grant_credits(v_uid, p_amount, p_reason);
    v_count := v_count + 1;
  END LOOP;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'bulk_grant_credits', 'user_set', NULL, jsonb_build_object('count', v_count, 'amount', p_amount, 'reason', p_reason, 'user_ids', p_user_ids));
  RETURN jsonb_build_object('granted_to', v_count, 'amount_each', p_amount);
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_bulk_grant_credits(uuid[], int, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_bulk_grant_credits(uuid[], int, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_bulk_suspend(
  p_user_ids uuid[], p_reason text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_uid uuid; v_count int := 0;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_bulk_suspend: forbidden' USING ERRCODE = '42501';
  END IF;
  FOREACH v_uid IN ARRAY p_user_ids LOOP
    PERFORM public.admin_set_user_status(v_uid, 'paused', p_reason);
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('suspended', v_count);
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_bulk_suspend(uuid[], text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_bulk_suspend(uuid[], text) TO authenticated;


-- ============================================================
-- Phase 9: Generations tab
-- ============================================================

-- View joining jobs to project context
CREATE OR REPLACE VIEW public.admin_v_jobs_with_project
WITH (security_invoker = true) AS
SELECT j.*, p.title AS project_title, p.format AS project_format,
       p.style AS project_style, p.length AS project_length,
       p.project_type AS project_type
FROM public.video_generation_jobs j
LEFT JOIN public.projects p ON p.id = j.project_id;

REVOKE ALL ON public.admin_v_jobs_with_project FROM anon;
GRANT SELECT ON public.admin_v_jobs_with_project TO authenticated;

-- 6. admin_generations_kpis()
CREATE OR REPLACE FUNCTION public.admin_generations_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_generations_kpis: forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'today',         (SELECT COALESCE(SUM(generation_count), 0)::int FROM public.admin_mv_daily_generation_stats WHERE day = CURRENT_DATE),
    'yesterday',     (SELECT COALESCE(SUM(generation_count), 0)::int FROM public.admin_mv_daily_generation_stats WHERE day = CURRENT_DATE - 1),
    'success_rate_pct', (SELECT CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE status = 'completed')::numeric / COUNT(*)::numeric * 100, 1) ELSE 100 END FROM public.video_generation_jobs WHERE created_at > NOW() - INTERVAL '24 hours' AND status IN ('completed','failed')),
    'success_rate_prev_pct', (SELECT CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE status = 'completed')::numeric / COUNT(*)::numeric * 100, 1) ELSE 100 END FROM public.video_generation_jobs WHERE created_at BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '24 hours' AND status IN ('completed','failed')),
    'median_time_s', (SELECT COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE(finished_at, updated_at) - COALESCE(started_at, created_at)))), 0)::int FROM public.video_generation_jobs WHERE status = 'completed' AND finished_at > NOW() - INTERVAL '1 hour'),
    'in_queue',      (SELECT COUNT(*)::int FROM public.video_generation_jobs WHERE status = 'pending'),
    'over_sla_5m',   (SELECT COUNT(*)::int FROM public.video_generation_jobs WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'),
    'in_progress',   (SELECT COUNT(*)::int FROM public.video_generation_jobs WHERE status = 'processing')
  ) INTO v;
  RETURN v;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_generations_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_generations_kpis() TO authenticated;

-- 7. admin_generations_by_type_7d()
CREATE OR REPLACE FUNCTION public.admin_generations_by_type_7d()
RETURNS TABLE (project_type text, count bigint, cost numeric, err_pct numeric, daily_counts int[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_generations_by_type_7d: forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH base AS (
    SELECT COALESCE(p.project_type, p.format, 'unknown') AS pt, j.id, j.status, j.created_at
    FROM public.video_generation_jobs j
    LEFT JOIN public.projects p ON p.id = j.project_id
    WHERE j.created_at > NOW() - INTERVAL '7 days'
  ),
  costs AS (
    SELECT g.user_id, SUM(a.cost) AS spend FROM public.api_call_logs a
    JOIN public.generations g ON g.id = a.generation_id
    WHERE a.created_at > NOW() - INTERVAL '7 days' AND a.cost IS NOT NULL
    GROUP BY g.user_id
  )
  SELECT
    b.pt::text,
    COUNT(*)::bigint,
    COALESCE((SELECT SUM(c.spend) FROM costs c), 0)::numeric AS cost,
    CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE b.status = 'failed')::numeric / COUNT(*)::numeric * 100, 1) ELSE 0 END,
    ARRAY(
      SELECT COUNT(*)::int FROM generate_series(0, 6) i
      LEFT JOIN public.video_generation_jobs j2
        ON COALESCE((SELECT pp.project_type FROM public.projects pp WHERE pp.id = j2.project_id), 'unknown') = b.pt
       AND j2.created_at::date = (CURRENT_DATE - i)::date
      GROUP BY i ORDER BY i
    )
  FROM base b
  GROUP BY b.pt
  ORDER BY 2 DESC;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_generations_by_type_7d() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_generations_by_type_7d() TO authenticated;

-- 8. admin_generations_list(p_search, p_status, p_type, p_since, p_limit, p_page)
CREATE OR REPLACE FUNCTION public.admin_generations_list(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,    -- 'pending'|'processing'|'completed'|'failed'|'all'
  p_type   text DEFAULT NULL,    -- task_type filter
  p_since  timestamptz DEFAULT NOW() - INTERVAL '7 days',
  p_limit  int DEFAULT 50,
  p_page   int DEFAULT 1
)
RETURNS TABLE (
  id uuid, user_id uuid, project_id uuid, project_title text,
  task_type text, status text, progress int, error_message text,
  created_at timestamptz, started_at timestamptz, finished_at timestamptz,
  worker_id text, retried_from uuid, project_type text, project_format text,
  total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_total bigint;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_generations_list: forbidden' USING ERRCODE = '42501';
  END IF;

  WITH filtered AS (
    SELECT v.* FROM public.admin_v_jobs_with_project v
    WHERE v.created_at >= p_since
      AND (p_search IS NULL OR p_search = '' OR
           v.id::text = p_search OR v.user_id::text = p_search OR
           COALESCE(v.project_title, '') ILIKE '%' || p_search || '%' OR
           COALESCE(v.error_message, '') ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status IN ('all','') OR v.status = p_status)
      AND (p_type IS NULL OR p_type IN ('all','') OR v.task_type = p_type)
  )
  SELECT COUNT(*) INTO v_total FROM filtered;

  RETURN QUERY
  WITH filtered AS (
    SELECT v.* FROM public.admin_v_jobs_with_project v
    WHERE v.created_at >= p_since
      AND (p_search IS NULL OR p_search = '' OR
           v.id::text = p_search OR v.user_id::text = p_search OR
           COALESCE(v.project_title, '') ILIKE '%' || p_search || '%' OR
           COALESCE(v.error_message, '') ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status IN ('all','') OR v.status = p_status)
      AND (p_type IS NULL OR p_type IN ('all','') OR v.task_type = p_type)
  )
  SELECT
    f.id, f.user_id, f.project_id, f.project_title,
    f.task_type, f.status, f.progress, f.error_message,
    f.created_at, f.started_at, f.finished_at,
    f.worker_id, f.retried_from, f.project_type, f.project_format,
    v_total
  FROM filtered f
  ORDER BY f.created_at DESC
  LIMIT GREATEST(p_limit, 1)
  OFFSET GREATEST(p_page - 1, 0) * GREATEST(p_limit, 1);
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_generations_list(text, text, text, timestamptz, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_generations_list(text, text, text, timestamptz, int, int) TO authenticated;

-- 9. admin_force_complete_job
CREATE OR REPLACE FUNCTION public.admin_force_complete_job(
  p_job_id uuid, p_result jsonb DEFAULT '{}'::jsonb, p_reason text DEFAULT 'Force-completed by admin'
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_old text;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_force_complete_job: forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO v_old FROM public.video_generation_jobs WHERE id = p_job_id FOR UPDATE;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'admin_force_complete_job: job not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.video_generation_jobs
     SET status = 'completed', finished_at = COALESCE(finished_at, NOW()), result = COALESCE(p_result, '{}'::jsonb), error_message = COALESCE(error_message, '') || ' | ' || p_reason, updated_at = NOW()
   WHERE id = p_job_id;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'force_complete_job', 'video_generation_job', p_job_id, jsonb_build_object('previous_status', v_old, 'reason', p_reason));
  RETURN jsonb_build_object('id', p_job_id, 'previous_status', v_old, 'status', 'completed');
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_force_complete_job(uuid, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_force_complete_job(uuid, jsonb, text) TO authenticated;

-- 10. admin_requeue_dead_letter
CREATE OR REPLACE FUNCTION public.admin_requeue_dead_letter(p_dlq_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_dlq RECORD; v_new_id uuid; v_payload jsonb;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_requeue_dead_letter: forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_dlq FROM public.dead_letter_jobs WHERE id = p_dlq_id;
  IF v_dlq IS NULL THEN
    RAISE EXCEPTION 'admin_requeue_dead_letter: dlq row not found' USING ERRCODE = 'P0002';
  END IF;

  v_payload := COALESCE(v_dlq.payload, '{}'::jsonb)
            || jsonb_build_object('_restartCount', COALESCE((v_dlq.payload ->> '_restartCount')::int, 0) + 1);

  INSERT INTO public.video_generation_jobs (user_id, project_id, task_type, status, payload, retried_from)
  VALUES (v_dlq.user_id, v_dlq.project_id, v_dlq.task_type, 'pending', v_payload, v_dlq.source_job_id)
  RETURNING id INTO v_new_id;

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'requeue_dead_letter', 'dead_letter_job', p_dlq_id, jsonb_build_object('new_job_id', v_new_id, 'task_type', v_dlq.task_type));

  RETURN jsonb_build_object('dlq_id', p_dlq_id, 'new_job_id', v_new_id);
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_requeue_dead_letter(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_requeue_dead_letter(uuid) TO authenticated;


-- ============================================================
-- Phase 10: Performance tab
-- ============================================================

-- 11. admin_perf_kpis()
CREATE OR REPLACE FUNCTION public.admin_perf_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_perf_kpis: forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'concurrency_in_flight', (SELECT COALESCE(SUM(in_flight), 0)::int FROM public.worker_heartbeats WHERE last_beat_at > NOW() - INTERVAL '90 seconds'),
    'concurrency_total',     (SELECT COALESCE(SUM(concurrency), 0)::int FROM public.worker_heartbeats WHERE last_beat_at > NOW() - INTERVAL '90 seconds'),
    'avg_job_time_s',        (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (finished_at - started_at))), 0)::numeric(10,1) FROM public.video_generation_jobs WHERE status = 'completed' AND finished_at > NOW() - INTERVAL '1 hour'),
    'avg_job_time_prev_s',   (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (finished_at - started_at))), 0)::numeric(10,1) FROM public.video_generation_jobs WHERE status = 'completed' AND finished_at BETWEEN NOW() - INTERVAL '8 days' AND NOW() - INTERVAL '7 days'),
    'queue_depth',           (SELECT COUNT(*)::int FROM public.video_generation_jobs WHERE status = 'pending'),
    'queue_over_sla',        (SELECT COUNT(*)::int FROM public.video_generation_jobs WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'),
    'throughput_1h',         (SELECT COUNT(*)::int FROM public.video_generation_jobs WHERE status = 'completed' AND finished_at > NOW() - INTERVAL '1 hour'),
    'throughput_per_min',    (SELECT ROUND(COUNT(*)::numeric / 60, 1) FROM public.video_generation_jobs WHERE status = 'completed' AND finished_at > NOW() - INTERVAL '1 hour'),
    'mem_p95_pct',           (SELECT COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY memory_pct), 0)::int FROM public.worker_heartbeats WHERE last_beat_at > NOW() - INTERVAL '5 minutes' AND memory_pct IS NOT NULL),
    'cpu_p95_pct',           (SELECT COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY cpu_pct), 0)::int FROM public.worker_heartbeats WHERE last_beat_at > NOW() - INTERVAL '5 minutes' AND cpu_pct IS NOT NULL)
  ) INTO v;
  RETURN v;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_perf_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_perf_kpis() TO authenticated;

-- 12. admin_perf_phase_timing()
CREATE OR REPLACE FUNCTION public.admin_perf_phase_timing()
RETURNS TABLE (phase text, avg_s numeric, p95_s numeric, sample_size bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_perf_phase_timing: forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    j.task_type::text AS phase,
    ROUND(AVG(EXTRACT(EPOCH FROM (j.finished_at - j.started_at)))::numeric, 1) AS avg_s,
    ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (j.finished_at - j.started_at)))::numeric, 1) AS p95_s,
    COUNT(*)::bigint AS sample_size
  FROM public.video_generation_jobs j
  WHERE j.status = 'completed'
    AND j.finished_at > NOW() - INTERVAL '1 hour'
    AND j.started_at IS NOT NULL
    AND j.finished_at IS NOT NULL
  GROUP BY j.task_type
  ORDER BY 4 DESC;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_perf_phase_timing() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_perf_phase_timing() TO authenticated;

-- 13. admin_workers_list()
CREATE OR REPLACE FUNCTION public.admin_workers_list()
RETURNS TABLE (
  worker_id text, host text, last_beat_at timestamptz,
  in_flight int, concurrency int, memory_pct numeric, cpu_pct numeric,
  version text, started_at timestamptz, restart_requested boolean,
  status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_workers_list: forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT w.worker_id, w.host, w.last_beat_at, w.in_flight, w.concurrency,
         w.memory_pct, w.cpu_pct, w.version, w.started_at, w.restart_requested,
         CASE
           WHEN w.last_beat_at < NOW() - INTERVAL '90 seconds' THEN 'dead'
           WHEN w.memory_pct > 80 OR w.cpu_pct > 85 THEN 'degraded'
           ELSE 'healthy'
         END::text AS status
  FROM public.worker_heartbeats w
  ORDER BY w.last_beat_at DESC;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_workers_list() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_workers_list() TO authenticated;

-- 14. admin_request_worker_restart(p_worker_id)
CREATE OR REPLACE FUNCTION public.admin_request_worker_restart(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_request_worker_restart: forbidden' USING ERRCODE = '42501';
  END IF;
  UPDATE public.worker_heartbeats SET restart_requested = TRUE WHERE worker_id = p_worker_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_request_worker_restart: worker not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'worker_restart_requested', 'worker', NULL, jsonb_build_object('worker_id', p_worker_id));
  RETURN jsonb_build_object('worker_id', p_worker_id, 'restart_requested', true);
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_request_worker_restart(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_request_worker_restart(text) TO authenticated;

-- 15. admin_perf_throughput_14d() — daily completed-job count
CREATE OR REPLACE FUNCTION public.admin_perf_throughput_14d()
RETURNS TABLE (day date, completed bigint, failed bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_perf_throughput_14d: forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT m.day,
         COALESCE(SUM(m.generation_count) FILTER (WHERE m.status = 'completed'), 0)::bigint AS completed,
         COALESCE(SUM(m.generation_count) FILTER (WHERE m.status = 'failed'), 0)::bigint AS failed
  FROM public.admin_mv_daily_generation_stats m
  WHERE m.day >= CURRENT_DATE - 13
  GROUP BY m.day
  ORDER BY m.day;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_perf_throughput_14d() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_perf_throughput_14d() TO authenticated;

COMMIT;
