-- ============================================================
-- Stagger + reduce cron firing rates to eliminate connection-pool
-- pile-up storms at :00/:15/:30/:45.
-- ============================================================
-- Background: on 2026-05-18 23:45 UTC five cron jobs all fired in the
-- same millisecond and pg_cron could not acquire connection slots to
-- start them — every one timed out with "job startup timeout" and a
-- user-facing frontend query was caught in the 12-second pressure
-- window with SQLSTATE 57014. Same pattern recurs at every multiple
-- of 5 minutes because `*/15`, `*/5`, and `*/1` all share `:00 :15
-- :30 :45` as common firing instants — the structural reason for the
-- pile-up.
--
-- Strategy:
--   1. Stagger each non-every-minute job at a PRIME-offset minute
--      so no two jobs ever share the same minute (apart from
--      autopost-tick which intentionally fires every minute).
--   2. Reduce honestly-not-time-sensitive jobs to the minimum
--      cadence the product actually needs:
--        - cleanup_regen_debounce: every 1 min → every 30 min.
--          The debounce table only needs row presence for ~1 min;
--          extra cleanup latency just leaves rows sitting longer
--          and consuming a few KB.
--        - kill-stuck-backends: every 5 min → every 30 min. The
--          function only acts on backends idle-in-transaction > 10
--          min or active > 30 min — there is no benefit to checking
--          more often than the threshold.
--        - drain-deletion-tasks: every 15 min → hourly. Account
--          deletion is not time-sensitive (GDPR allows 30 days).
--        - run-email-drips: every 15 min → hourly. Drip cadence is
--          daily/weekly downstream, the 15-min poll was already
--          coarser than the underlying schedule.
--   3. autopost-tick stays at every minute — fires user-scheduled
--      posts on the minute. Reducing this would visibly delay
--      product timing.
--   4. refresh-admin-views stays at `0 * * * *` (per
--      20260518200000_*). It already runs CONCURRENTLY under an
--      advisory lock so the `:00` co-fire with autopost-tick is
--      harmless.
--
-- Result: ~67 cron firings/hour, down from ~141. No two jobs ever
-- share a firing minute except the intentional autopost-tick pair.
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── cleanup_regen_debounce: every 1 min → :22, :52 ───────────────
DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('cleanup_regen_debounce');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'cleanup_regen_debounce',
  '22,52 * * * *',
  $$ DELETE FROM public.regen_debounce WHERE created_at < NOW() - INTERVAL '1 minute'; $$
);

-- ── kill-stuck-backends: every 5 min → :11, :41 ──────────────────
DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('kill-stuck-backends');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'kill-stuck-backends',
  '11,41 * * * *',
  $$ SELECT public.kill_stuck_backends(); $$
);

-- ── drain-deletion-tasks: every 15 min → :17 ─────────────────────
-- The job body (vault-based service-role key) is unchanged from
-- 20260518200100_*. We re-register only to change the schedule.
DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('drain-deletion-tasks');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'drain-deletion-tasks',
  '17 * * * *',
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

-- ── run-email-drips: every 15 min → :33 ──────────────────────────
DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('run-email-drips');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'run-email-drips',
  '33 * * * *',
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

COMMIT;
