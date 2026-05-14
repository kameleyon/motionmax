-- DIAGNOSTIC ONLY — runs EXPLAIN (ANALYZE, BUFFERS) on autopost_tick()
-- and emits the plan via RAISE NOTICE so the push output captures it.
--
-- Why a migration: there's no `supabase db query` subcommand for remote;
-- migrations are the only way to run server-side SQL from CI. We're not
-- mutating anything here — EXPLAIN ANALYZE does fire the function once,
-- but autopost_tick is idempotent (just processes due schedules), so
-- running it once outside the normal cron schedule is equivalent to a
-- single early tick. With 16 rows in autopost_schedules, the blast
-- radius is at most a handful of due-schedule fires.
--
-- After capturing the plan, this migration is harmless to keep in the
-- history — it leaves no schema artifacts.

DO $$
DECLARE
  plan_row RECORD;
  start_ts TIMESTAMPTZ := clock_timestamp();
BEGIN
  RAISE NOTICE '════════ EXPLAIN ANALYZE: autopost_tick() ════════';
  FOR plan_row IN EXECUTE
    'EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT) SELECT public.autopost_tick()'
  LOOP
    RAISE NOTICE '%', plan_row."QUERY PLAN";
  END LOOP;
  RAISE NOTICE '════════ wall: % ════════',
    EXTRACT(EPOCH FROM (clock_timestamp() - start_ts));
END$$;
