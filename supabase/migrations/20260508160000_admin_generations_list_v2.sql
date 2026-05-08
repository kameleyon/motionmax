-- ============================================================
-- Phase 9.4 — admin_generations_list returns user + cost + payload
-- ============================================================
-- The original signature in 20260505230000 returned only base columns
-- from admin_v_jobs_with_project. The Generations tab UI needs:
--   - user_name / user_email / user_plan (currently rendered as "—")
--   - cost (from generation_costs.total_cost)
--   - payload (for the drilldown)
--   - output_summary (a derived one-liner from the payload)
--   - generation_id (extracted from payload for cross-table lookups)
--
-- We drop the prior signature and recreate. Same parameter list, so
-- the client doesn't need a coordinated cutover.

BEGIN;

DROP FUNCTION IF EXISTS public.admin_generations_list(text, text, text, timestamptz, int, int);

CREATE OR REPLACE FUNCTION public.admin_generations_list(
  p_search text DEFAULT NULL,
  p_status text DEFAULT NULL,    -- 'pending'|'processing'|'completed'|'failed'|'cancelled'|'all'
  p_type   text DEFAULT NULL,    -- task_type filter
  p_since  timestamptz DEFAULT NOW() - INTERVAL '7 days',
  p_limit  int DEFAULT 50,
  p_page   int DEFAULT 1
)
RETURNS TABLE (
  job_id uuid,
  user_id uuid,
  user_name text,
  user_email text,
  user_plan text,
  task_type text,
  project_id uuid,
  project_title text,
  project_type text,
  status text,
  progress int,
  error_message text,
  created_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  worker_id text,
  retried_from uuid,
  payload jsonb,
  generation_id uuid,
  output_summary text,
  cost numeric,
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
           v.id::text       = p_search OR
           v.user_id::text  = p_search OR
           COALESCE(v.project_title, '')   ILIKE '%' || p_search || '%' OR
           COALESCE(v.error_message, '')   ILIKE '%' || p_search || '%' OR
           v.payload::text                 ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status IN ('all','') OR v.status = p_status)
      AND (p_type   IS NULL OR p_type   IN ('all','') OR v.task_type = p_type)
  )
  SELECT COUNT(*) INTO v_total FROM filtered;

  RETURN QUERY
  WITH filtered AS (
    SELECT v.* FROM public.admin_v_jobs_with_project v
    WHERE v.created_at >= p_since
      AND (p_search IS NULL OR p_search = '' OR
           v.id::text       = p_search OR
           v.user_id::text  = p_search OR
           COALESCE(v.project_title, '')   ILIKE '%' || p_search || '%' OR
           COALESCE(v.error_message, '')   ILIKE '%' || p_search || '%' OR
           v.payload::text                 ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status IN ('all','') OR v.status = p_status)
      AND (p_type   IS NULL OR p_type   IN ('all','') OR v.task_type = p_type)
  )
  SELECT
    f.id                                              AS job_id,
    f.user_id,
    p.display_name                                    AS user_name,
    au.email                                          AS user_email,
    s.plan_name                                       AS user_plan,
    f.task_type,
    f.project_id,
    f.project_title,
    f.project_type,
    f.status,
    f.progress,
    f.error_message,
    f.created_at,
    f.started_at,
    f.finished_at,
    f.worker_id,
    f.retried_from,
    f.payload,
    -- generation_id can be at payload->generationId (camelCase from worker)
    -- or payload->generation_id (snake_case in some legacy paths). Coalesce.
    NULLIF(COALESCE(f.payload->>'generationId', f.payload->>'generation_id'), '')::uuid
                                                      AS generation_id,
    -- One-liner output summary: prompt OR topic OR style OR fallback to
    -- task_type + project. Keep it short — the UI truncates anyway.
    LEFT(
      COALESCE(
        NULLIF(f.payload->>'prompt', ''),
        NULLIF(f.payload->>'topic', ''),
        NULLIF(f.payload->>'style', ''),
        NULLIF(f.payload->>'finalPrompt', ''),
        f.task_type || ' · ' || COALESCE(f.project_title, '?')
      ),
      160
    )                                                 AS output_summary,
    COALESCE(gc.total_cost, 0)::numeric               AS cost,
    v_total                                           AS total_count
  FROM filtered f
  LEFT JOIN public.profiles p   ON p.user_id = f.user_id
  LEFT JOIN auth.users au       ON au.id     = f.user_id
  LEFT JOIN public.subscriptions s
         ON s.user_id = f.user_id AND s.status IN ('active','trialing')
  LEFT JOIN public.generation_costs gc
         ON gc.generation_id = NULLIF(COALESCE(f.payload->>'generationId', f.payload->>'generation_id'), '')::uuid
  ORDER BY f.created_at DESC
  LIMIT GREATEST(p_limit, 1)
  OFFSET GREATEST(p_page - 1, 0) * GREATEST(p_limit, 1);
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_generations_list(text, text, text, timestamptz, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_generations_list(text, text, text, timestamptz, int, int) TO authenticated;

-- ── Drilldown helper: pipeline trace + api calls + cost breakdown
-- Returns a single jsonb aggregate so the drawer can fetch everything
-- in one round-trip instead of three separate selects.
CREATE OR REPLACE FUNCTION public.admin_generation_detail(p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE
  v_job   public.video_generation_jobs;
  v_genid uuid;
  v_out   jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_generation_detail: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_job FROM public.video_generation_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_generation_detail: job % not found', p_job_id USING ERRCODE = '02000';
  END IF;

  v_genid := NULLIF(COALESCE(v_job.payload->>'generationId', v_job.payload->>'generation_id'), '')::uuid;

  SELECT jsonb_build_object(
    'job', to_jsonb(v_job),
    'generation_id', v_genid,
    'pipeline_trace', COALESCE((
      SELECT jsonb_agg(to_jsonb(sl) ORDER BY sl.created_at ASC)
      FROM (
        SELECT created_at, category, event_type, message, details
        FROM public.system_logs
        WHERE (job_id = p_job_id OR (v_genid IS NOT NULL AND generation_id = v_genid))
        ORDER BY created_at ASC
        LIMIT 200
      ) sl
    ), '[]'::jsonb),
    'api_calls', COALESCE((
      SELECT jsonb_agg(to_jsonb(ac) ORDER BY ac.created_at ASC)
      FROM (
        SELECT id, provider, model, status, queue_time_ms, running_time_ms, total_duration_ms,
               cost, error_message, created_at
        FROM public.api_call_logs
        WHERE v_genid IS NOT NULL AND generation_id = v_genid
        ORDER BY created_at ASC
        LIMIT 100
      ) ac
    ), '[]'::jsonb),
    'cost_breakdown', (
      SELECT to_jsonb(gc) FROM public.generation_costs gc
      WHERE v_genid IS NOT NULL AND gc.generation_id = v_genid
      LIMIT 1
    )
  ) INTO v_out;

  RETURN v_out;
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_generation_detail(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_generation_detail(uuid) TO authenticated;

COMMIT;
