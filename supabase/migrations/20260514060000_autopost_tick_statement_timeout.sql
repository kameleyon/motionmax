-- Bump per-function statement_timeout on autopost_tick.
--
-- Context: autopost_tick() runs every 5 minutes via pg_cron and currently
-- averages 3.2s with growing autopost_schedules. Under DB contention
-- (Realtime WAL poller + admin materialized view refreshes + checkpoint
-- writes) it can exceed Supabase's default 8s API statement_timeout and
-- get killed mid-execution — leaving autopost_runs rows half-written and
-- next_fire_at unmoved, which then causes the same schedules to fire on
-- the next tick and pile up. Verified 2026-05-14 02:04–02:05 where a
-- save-autopost mutation died at the same time as a cron-fired tick.
--
-- Bumping to 30s gives the function enough headroom to finish under
-- contention without changing the global timeout (which would defeat the
-- API safety guard).

ALTER FUNCTION public.autopost_tick() SET statement_timeout = '30s';
