-- ============================================================
-- Repair drain-deletion-tasks + run-email-drips cron jobs
-- ============================================================
-- Background: both jobs have been failing every 15 min with
--   ERROR:  unrecognized configuration parameter "app.supabase_url"
-- because their command bodies read the URL and the service-role
-- key from custom GUCs (current_setting('app.supabase_url'),
-- current_setting('app.service_role_key')) that are not actually
-- set on this database. We are not using GUCs anymore because:
--   * ALTER DATABASE permission for the app.* prefix is unavailable
--     from the project owner role.
--   * GUCs silently disappear on certain Supabase config resets.
--
-- New scheme:
--   * Project URL is hardcoded (it is public and embedded in every
--     anon-key request already).
--   * Service-role key is read from Vault. The operator must run
--     ONE TIME, from the Supabase dashboard SQL Editor:
--       SELECT vault.create_secret('<service_role_key>',
--                                  'worker_service_role_key');
--     After that, every cron firing decrypts on demand.
--
-- Until the vault secret exists, the cron Authorization header will
-- be 'Bearer ' (empty), and the function will reject — no change in
-- behavior from today's failure mode, but the error message becomes
-- explicit (401 instead of "unrecognized configuration parameter").
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── drain-deletion-tasks: re-register with hardcoded URL + vault key ──
DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('drain-deletion-tasks');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'drain-deletion-tasks',
  '*/15 * * * *',
  $cmd$
  SELECT net.http_post(
    url     := 'https://ayjbvcikuwknqdrpsdmj.supabase.co/functions/v1/drain-deletion-tasks',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || COALESCE(
        (SELECT decrypted_secret
           FROM vault.decrypted_secrets
          WHERE name = 'worker_service_role_key'
          LIMIT 1),
        ''
      ),
      'Content-Type',  'application/json'
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- ── run-email-drips: same pattern ──
DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('run-email-drips');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'run-email-drips',
  '*/15 * * * *',
  $cmd$
  SELECT net.http_post(
    url     := 'https://ayjbvcikuwknqdrpsdmj.supabase.co/functions/v1/run-email-drips',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || COALESCE(
        (SELECT decrypted_secret
           FROM vault.decrypted_secrets
          WHERE name = 'worker_service_role_key'
          LIMIT 1),
        ''
      ),
      'Content-Type',  'application/json'
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- ── weekly-storage-cleanup uses the same broken pattern — fix too ──
DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('weekly-storage-cleanup');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'weekly-storage-cleanup',
  '0 2 * * 0',
  $cmd$
  SELECT net.http_post(
    url     := 'https://ayjbvcikuwknqdrpsdmj.supabase.co/functions/v1/cleanup-intermediate-storage',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || COALESCE(
        (SELECT decrypted_secret
           FROM vault.decrypted_secrets
          WHERE name = 'worker_service_role_key'
          LIMIT 1),
        ''
      ),
      'Content-Type',  'application/json'
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- ── operator nudge ──
DO $$
DECLARE
  has_key boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'worker_service_role_key'
  ) INTO has_key;
  IF NOT has_key THEN
    RAISE NOTICE
      'Vault secret worker_service_role_key is NOT set. Run, ONCE, from the dashboard SQL Editor: SELECT vault.create_secret(''<service_role_key>'', ''worker_service_role_key'');';
  END IF;
END $$;

COMMIT;
