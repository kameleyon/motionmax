-- Drop 4 high-churn admin-only tables from the supabase_realtime
-- publication so the WAL decoder stops walking them on every change.
--
-- Context: pg_stat_statements showed the Realtime WAL poller at 55.8%
-- of total DB time with 1.7M calls. The DB has 9 active profiles and a
-- per-user subscription volume that can't account for that load — it's
-- the decoder itself walking publication-enabled tables on every WAL
-- record. The fix is to remove tables that don't actually need live
-- broadcast: admin-only observability tables where a 10-second poll
-- is indistinguishable from "live" in practice.
--
-- Frontend prep landed in the same PR:
--   * TabConsole       polling tail @ 10s replaces system_logs Realtime
--   * TabActivity      refetchInterval: 10_000 on baseQuery
--   * TabOverview      refetchInterval: 10_000 on feed query
--   * TabPerformance   already polls workers + kpis @ 15s (no change)
--   * AdminRecentActions  already polls every 30s (no change)
--
-- The existing supabase.channel(...).on("postgres_changes", { table:
-- "system_logs"|"worker_heartbeats"|"dead_letter_jobs"|"admin_logs" })
-- subscriptions in the React code remain in place. After this migration
-- they receive no events (the table is no longer in the publication),
-- which is the desired no-op behavior. The subscriptions are cheap
-- when idle (just an open WebSocket) and the polling shoulders the
-- actual data freshness.
--
-- Tables we deliberately KEEP in the publication:
--   * video_generation_jobs  - editor needs live progress updates
--   * generations            - editor + project pages
--   * projects               - sidebar + projects gallery
--   * user_notifications     - notifications popover
--   * autopost_*             - autopost UI needs live status
--   * announcements          - banner refresh
--   * admin_messages         - admin chat feel
--   * admin_message_threads  - admin chat feel
--   * feature_flags          - kill-switch instant effect
--   * app_settings           - kill-switch instant effect
--
-- Rollback: ALTER PUBLICATION supabase_realtime ADD TABLE <name> for
-- each, in any order. Idempotent re-add.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'system_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.system_logs;
    RAISE NOTICE 'Dropped public.system_logs from supabase_realtime';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'worker_heartbeats'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.worker_heartbeats;
    RAISE NOTICE 'Dropped public.worker_heartbeats from supabase_realtime';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'dead_letter_jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.dead_letter_jobs;
    RAISE NOTICE 'Dropped public.dead_letter_jobs from supabase_realtime';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'admin_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.admin_logs;
    RAISE NOTICE 'Dropped public.admin_logs from supabase_realtime';
  END IF;
END$$;
