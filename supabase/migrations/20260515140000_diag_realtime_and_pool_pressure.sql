-- ============================================================
-- DIAGNOSTIC ONLY — read-only. Dumps the data we need to decide:
--   (a) Which tables are still in supabase_realtime → drop heavy churners.
--   (b) What's the WAL traffic distribution across tables.
--   (c) Whether the existing pg_cron schedules are still active.
--   (d) Who's holding connections / sitting in idle-in-transaction.
--   (e) Top-called functions (looking for the 932×/day MV refresh caller).
--
-- All output via RAISE NOTICE so it lands in `supabase db push` stdout
-- without leaving any schema changes behind. Safe to re-run.
-- Run date: 2026-05-15. Owner: connection-pool exhaustion remediation.
-- ============================================================

BEGIN;

-- ── 1. supabase_realtime publication membership ─────────────
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  RAISE NOTICE '═════ supabase_realtime publication tables ═════';
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
    ORDER BY schemaname, tablename
  LOOP
    RAISE NOTICE '  %.%', r.schemaname, r.tablename;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '  (total: % tables)', n;
END $$;

-- ── 2. Top 20 WAL-write tables (lifetime) ───────────────────
DO $$
DECLARE
  r record;
BEGIN
  RAISE NOTICE '═════ top 20 write-heavy tables (lifetime n_tup_ins + upd + del) ═════';
  FOR r IN
    SELECT schemaname, relname,
           n_tup_ins, n_tup_upd, n_tup_del,
           (n_tup_ins + n_tup_upd + n_tup_del) AS total
    FROM pg_stat_user_tables
    ORDER BY (n_tup_ins + n_tup_upd + n_tup_del) DESC
    LIMIT 20
  LOOP
    RAISE NOTICE '  %.%  total=%  ins=%  upd=%  del=%',
      r.schemaname, r.relname, r.total, r.n_tup_ins, r.n_tup_upd, r.n_tup_del;
  END LOOP;
END $$;

-- ── 3. Current pg_cron schedules ────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  RAISE NOTICE '═════ pg_cron jobs ═════';
  FOR r IN
    SELECT jobid, jobname, schedule, active,
           LEFT(command, 80) AS cmd_preview
    FROM cron.job
    ORDER BY jobname
  LOOP
    RAISE NOTICE '  #% % @ % active=% — %',
      r.jobid, r.jobname, r.schedule, r.active, r.cmd_preview;
  END LOOP;
END $$;

-- ── 4. Idle-in-transaction + long-running queries ───────────
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  RAISE NOTICE '═════ pg_stat_activity: stuck/idle backends >1 min ═════';
  FOR r IN
    SELECT pid,
           state,
           usename,
           application_name,
           age(now(), state_change) AS in_state,
           age(now(), xact_start) AS in_xact,
           LEFT(COALESCE(query, ''), 100) AS query_preview
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND state IS NOT NULL
      AND state <> 'active'
      AND state_change IS NOT NULL
      AND age(now(), state_change) > interval '1 minute'
    ORDER BY state_change ASC
    LIMIT 20
  LOOP
    RAISE NOTICE '  pid=% state=% in_state=% in_xact=% user=% app=% query=%',
      r.pid, r.state, r.in_state, r.in_xact, r.usename, r.application_name, r.query_preview;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '  (total stuck/idle: %)', n;
END $$;

-- ── 5. Top-called user functions (looking for MV refresh hot caller) ─
DO $$
DECLARE
  r record;
BEGIN
  RAISE NOTICE '═════ top 20 user functions by call count ═════';
  FOR r IN
    SELECT schemaname, funcname, calls,
           ROUND(total_time::numeric / 1000.0, 1) AS total_sec,
           ROUND((total_time / NULLIF(calls, 0))::numeric, 1) AS mean_ms
    FROM pg_stat_user_functions
    ORDER BY calls DESC
    LIMIT 20
  LOOP
    RAISE NOTICE '  %.%  calls=%  total=%s  mean=%ms',
      r.schemaname, r.funcname, r.calls, r.total_sec, r.mean_ms;
  END LOOP;
END $$;

-- ── 6. Connection count by state + application ──────────────
DO $$
DECLARE
  r record;
BEGIN
  RAISE NOTICE '═════ open connections by state × app ═════';
  FOR r IN
    SELECT state, application_name, COUNT(*) AS n
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
    GROUP BY state, application_name
    ORDER BY n DESC
    LIMIT 15
  LOOP
    RAISE NOTICE '  state=% app=% count=%',
      COALESCE(r.state, '(null)'), COALESCE(r.application_name, '(null)'), r.n;
  END LOOP;
END $$;

COMMIT;
