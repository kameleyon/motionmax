-- ============================================================
-- Schedule drain-deletion-tasks edge function via pg_cron
--
-- Runs every 15 minutes to drain the deletion_tasks queue,
-- which handles ElevenLabs voice and Stripe customer cleanup
-- for deleted accounts.
--
-- Requires:
--   • pg_cron extension (enabled via Supabase dashboard)
--   • pg_net extension (enabled via Supabase dashboard)
--   • app.supabase_url and app.service_role_key GUC settings
-- ============================================================

SELECT cron.schedule(
  'drain-deletion-tasks',
  '*/15 * * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/drain-deletion-tasks',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key')),
    body := '{}'::jsonb
  )$$
);
