-- ============================================================
-- Pool-exhaustion safety net: scheduled killer for stuck backends.
-- ============================================================
-- Background: on 2026-05-15 the connection pool exhausted with
-- SQLSTATE 53300 ("remaining connection slots are reserved").
-- The 2026-05-15 diagnostic showed no idle-in-transaction backends
-- at that moment (a DB restart had just cleared them), but we want
-- a continuous safety net so the next regression is reaped within
-- 5 min instead of paging an operator.
--
-- What this kills:
--   (a) state = 'idle in transaction' for >10 min  — almost always
--       a worker that crashed between BEGIN and COMMIT/ROLLBACK, or
--       a client that disconnected without a graceful shutdown.
--       Holds locks + a slot indefinitely. Safe to kill.
--   (b) state = 'active' for >30 min, AND the query is not a
--       vacuum/REINDEX — anything legitimate completes well inside
--       30 min on our schema (autopost_tick is statement_timeout-
--       capped at 8s, video processing is in the worker not the
--       DB). A 30-min query is a runaway or a stuck cursor.
--
-- What this does NOT kill:
--   * Backends owned by supabase_admin, supabase_storage_admin,
--     authenticator, or pgbouncer — these are infra-owned pooled
--     connections; terminating them creates cascading reconnects.
--   * pg_cron scheduler's own backends.
--   * autovacuum / REINDEX / VACUUM queries — these legitimately
--     run for hours on large tables.
--
-- Outputs:
--   * Each kill emits a RAISE WARNING with pid/state/age/query —
--     Supabase forwards WARNINGs to the project logs, which the
--     existing Sentry log-forwarding picks up.
--   * Each kill also writes one row to system_logs with category
--     = 'system_warning' + event_type = 'backend_terminated' so the
--     admin Console tab shows the history.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.kill_stuck_backends()
RETURNS TABLE (pid integer, state text, age_seconds integer, query_preview text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  victim record;
BEGIN
  FOR victim IN
    SELECT
      s.pid,
      s.state,
      EXTRACT(EPOCH FROM age(now(), COALESCE(s.xact_start, s.state_change)))::integer AS age_seconds,
      LEFT(COALESCE(s.query, ''), 200) AS query_preview
    FROM pg_stat_activity s
    WHERE s.pid <> pg_backend_pid()
      AND s.usename NOT IN ('supabase_admin', 'supabase_storage_admin', 'authenticator', 'pgbouncer', 'supabase_auth_admin', 'supabase_replication_admin', 'supabase_realtime_admin')
      AND COALESCE(s.application_name, '') NOT LIKE 'pg_cron%'
      AND COALESCE(s.application_name, '') NOT LIKE 'Supavisor%'
      AND (
        (s.state = 'idle in transaction' AND age(now(), s.state_change) > interval '10 minutes')
        OR (
          s.state = 'active'
          AND s.xact_start IS NOT NULL
          AND age(now(), s.xact_start) > interval '30 minutes'
          AND COALESCE(s.query, '') NOT ILIKE 'autovacuum:%'
          AND COALESCE(s.query, '') NOT ILIKE '%REINDEX%'
          AND COALESCE(s.query, '') NOT ILIKE '%VACUUM%'
        )
      )
  LOOP
    -- pg_terminate_backend returns true if the signal was sent.
    -- Race: the backend may exit before we signal — that's fine,
    -- the function still returns false and we just skip the log row.
    IF pg_terminate_backend(victim.pid) THEN
      RAISE WARNING 'kill_stuck_backends: terminated pid=% state=% age=%s query=%',
        victim.pid, victim.state, victim.age_seconds, victim.query_preview;

      -- Best-effort audit log; failure to insert here must not abort
      -- the loop (e.g. system_logs hits its own statement_timeout).
      BEGIN
        INSERT INTO public.system_logs (
          id, category, event_type, message, details, created_at
        ) VALUES (
          gen_random_uuid(),
          'system_warning',
          'backend_terminated',
          format('Terminated %s backend pid=%s after %ss', victim.state, victim.pid, victim.age_seconds),
          jsonb_build_object(
            'pid', victim.pid,
            'state', victim.state,
            'age_seconds', victim.age_seconds,
            'query_preview', victim.query_preview,
            'reaper', 'kill_stuck_backends'
          ),
          now()
        );
      EXCEPTION WHEN OTHERS THEN
        -- Don't let logging failure mask the kill itself.
        NULL;
      END;

      pid := victim.pid;
      state := victim.state;
      age_seconds := victim.age_seconds;
      query_preview := victim.query_preview;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.kill_stuck_backends() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kill_stuck_backends() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kill_stuck_backends() TO service_role;

COMMENT ON FUNCTION public.kill_stuck_backends() IS
  'Terminates idle-in-transaction backends >10min and active queries >30min (excluding vacuum/REINDEX). Returns one row per kill. Scheduled every 5 min via pg_cron job kill-stuck-backends.';

-- ── pg_cron schedule (every 5 min) ────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('kill-stuck-backends');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'kill-stuck-backends',
  '*/5 * * * *',
  $$ SELECT public.kill_stuck_backends(); $$
);

COMMIT;
