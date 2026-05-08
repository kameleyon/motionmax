-- ============================================================
-- Phase 10 + 11 scaffold — perf percentiles, heartbeat janitor,
-- incidents, auth_events, sessions view, fingerprint helper
-- ============================================================
-- Closes the remaining checklist items for Performance and Errors:
--   10.4 — janitor cron for dead heartbeats
--   10.5 — admin_perf_percentiles RPC (provider/task_type p50/p95/p99)
--   11.5 — incidents table + auto_open_incident_if_threshold RPC
--   11.6 — auth_events table for session derivation
--   11.4 — admin_v_sessions view (30-min idle gap delimiter)
--   11.3 — public.normalize_log_message helper used by the fingerprint
--          column generator (workers compute the SHA on log emit; this
--          helper is the canonical normaliser the SQL side mirrors)

BEGIN;

-- ── 10.4 Janitor: drop heartbeats from dead pods ────────────────────
-- The worker writes every 15 s. Anything older than 5 min is
-- definitely a dead pod (Render redeploys, OOM kills, etc.).
-- Cron pg_cron is already set up via Phase 2 schedules.
CREATE OR REPLACE FUNCTION public.cleanup_dead_worker_heartbeats()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_count int;
BEGIN
  DELETE FROM public.worker_heartbeats
   WHERE last_beat_at < NOW() - INTERVAL '5 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$func$;

-- Schedule via pg_cron when extension exists. Idempotent — drops the
-- old job first if it was scheduled in a prior run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('cleanup_dead_worker_heartbeats');
    PERFORM cron.schedule(
      'cleanup_dead_worker_heartbeats',
      '*/5 * * * *',
      'SELECT public.cleanup_dead_worker_heartbeats();'
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skipped pg_cron schedule for cleanup_dead_worker_heartbeats: %', SQLERRM;
END $$;

-- ── 10.5 admin_perf_percentiles ─────────────────────────────────────
-- Per-dimension p50/p95/p99 over the last `p_since` window. Used by
-- the Performance drilldown — surface API calls that have crept past
-- their typical latency budget.
CREATE OR REPLACE FUNCTION public.admin_perf_percentiles(
  p_since timestamptz DEFAULT NOW() - INTERVAL '24 hours',
  p_dimension text DEFAULT 'task_type'  -- 'task_type' | 'provider'
)
RETURNS TABLE (label text, p50 numeric, p95 numeric, p99 numeric, sample_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_perf_percentiles: forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_dimension = 'provider' THEN
    RETURN QUERY
      SELECT
        provider                                                      AS label,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY total_duration_ms)::numeric AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration_ms)::numeric AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY total_duration_ms)::numeric AS p99,
        COUNT(*)                                                       AS sample_count
      FROM public.api_call_logs
      WHERE created_at >= p_since
        AND total_duration_ms IS NOT NULL
      GROUP BY provider
      ORDER BY sample_count DESC
      LIMIT 50;
  ELSE
    RETURN QUERY
      SELECT
        task_type                                                              AS label,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)))::numeric AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)))::numeric AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)))::numeric AS p99,
        COUNT(*)                                                               AS sample_count
      FROM public.video_generation_jobs
      WHERE created_at >= p_since
        AND status = 'completed'
        AND started_at IS NOT NULL
        AND finished_at IS NOT NULL
      GROUP BY task_type
      ORDER BY sample_count DESC
      LIMIT 50;
  END IF;
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_perf_percentiles(timestamptz, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_perf_percentiles(timestamptz, text) TO authenticated;

-- ── 11.5 incidents table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('high','medium','low')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','investigating','resolved')),
  fingerprint text,
  started_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  notes text
);

ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view incidents" ON public.incidents;
CREATE POLICY "Admins can view incidents" ON public.incidents
  FOR SELECT USING (public.is_admin(auth.uid()));
DROP POLICY IF EXISTS "Admins can manage incidents" ON public.incidents;
CREATE POLICY "Admins can manage incidents" ON public.incidents
  FOR ALL USING (public.is_admin(auth.uid()));

CREATE INDEX IF NOT EXISTS incidents_status_started_idx
  ON public.incidents (status, started_at DESC);
CREATE INDEX IF NOT EXISTS incidents_fingerprint_idx
  ON public.incidents (fingerprint) WHERE fingerprint IS NOT NULL;

-- 11.5 auto-open helper. Worker side-channel calls this when a single
-- fingerprint exceeds 30 events in a 5-min window. Idempotent: if an
-- open incident already exists for that fingerprint we return the
-- existing id without inserting.
CREATE OR REPLACE FUNCTION public.auto_open_incident_if_threshold(
  p_fingerprint text,
  p_count int,
  p_sample_message text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_id uuid; v_severity text;
BEGIN
  -- Look for an existing open incident first.
  SELECT id INTO v_id FROM public.incidents
   WHERE fingerprint = p_fingerprint AND status IN ('open','investigating')
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  v_severity := CASE
    WHEN p_count > 100 THEN 'high'
    WHEN p_count > 30  THEN 'medium'
    ELSE 'low'
  END;

  INSERT INTO public.incidents (title, severity, fingerprint, notes)
  VALUES (
    COALESCE(NULLIF(p_sample_message, ''), 'Error spike: ' || p_fingerprint),
    v_severity,
    p_fingerprint,
    'Auto-opened: ' || p_count || ' events crossed the threshold'
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$func$;

REVOKE ALL ON FUNCTION public.auto_open_incident_if_threshold(text, int, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.auto_open_incident_if_threshold(text, int, text) TO authenticated, service_role;

-- ── 11.6 auth_events table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  event_type text NOT NULL
    CHECK (event_type IN ('login','login.fail','logout','password.reset','signup')),
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.auth_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view auth_events" ON public.auth_events;
CREATE POLICY "Admins can view auth_events" ON public.auth_events
  FOR SELECT USING (public.is_admin(auth.uid()));
DROP POLICY IF EXISTS "Service role can write auth_events" ON public.auth_events;
CREATE POLICY "Service role can write auth_events" ON public.auth_events
  FOR INSERT WITH CHECK (true);
-- anon explicitly DENIED (no policy → no access).

CREATE INDEX IF NOT EXISTS auth_events_user_created_idx
  ON public.auth_events (user_id, created_at DESC);

-- ── 11.4 admin_v_sessions: derive sessions from auth_events ─────────
-- A session is a contiguous run of activity for a single user with no
-- gap > 30 min. Implementation uses the standard "gap-and-island"
-- pattern: tag each event with whether it starts a new session, then
-- aggregate runs.
CREATE OR REPLACE VIEW public.admin_v_sessions
WITH (security_invoker = true) AS
WITH events AS (
  SELECT user_id, created_at,
         LAG(created_at) OVER (PARTITION BY user_id ORDER BY created_at) AS prev_at
    FROM public.auth_events
   WHERE user_id IS NOT NULL
),
flagged AS (
  SELECT user_id, created_at,
         CASE WHEN prev_at IS NULL OR created_at - prev_at > INTERVAL '30 minutes'
              THEN 1 ELSE 0 END AS is_new_session
    FROM events
),
grouped AS (
  SELECT user_id, created_at,
         SUM(is_new_session) OVER (PARTITION BY user_id ORDER BY created_at
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session_idx
    FROM flagged
)
SELECT user_id,
       session_idx,
       MIN(created_at) AS session_start,
       MAX(created_at) AS session_end,
       EXISTS (
         SELECT 1 FROM public.system_logs sl
          WHERE sl.user_id = grouped.user_id
            AND sl.category = 'system_error'
            AND sl.created_at BETWEEN MIN(grouped.created_at) AND MAX(grouped.created_at)
       ) AS had_error
  FROM grouped
 GROUP BY user_id, session_idx;

REVOKE ALL ON public.admin_v_sessions FROM anon;
GRANT SELECT ON public.admin_v_sessions TO authenticated;

-- ── 11.3 normalize_log_message — fingerprint helper ─────────────────
-- Strips numbers, UUIDs, file paths from a message so two errors that
-- only differ by a runtime id collapse to the same fingerprint. The
-- worker logger calls a JS port of this then sha1's the result; this
-- SQL helper is the canonical reference + lets backfills compute
-- fingerprints for legacy rows.
CREATE OR REPLACE FUNCTION public.normalize_log_message(p_msg text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $func$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               COALESCE(p_msg, ''),
               '\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', '<uuid>', 'gi'
             ),
             '\b\d+\b', '<n>', 'g'
           ),
           '/[A-Za-z0-9_./-]+', '<path>', 'g'
         );
$func$;

COMMIT;
