-- ============================================================
-- Phase 3 — DLQ ops: account attribution, requeue RPC, spike alert.
-- ============================================================
-- 1. Add account_id to dead_letter_jobs so API-originated failures can be
--    attributed to a tenant account (the worker DLQ insert sets it from
--    job.account_id). Nullable: browser/non-API jobs have no account.
-- 2. api_requeue_dead_letter(uuid[]) — service-role/admin op that re-enqueues
--    dead-lettered jobs back onto video_generation_jobs (status 'pending')
--    and deletes the DLQ rows. Returns the number of jobs requeued.
-- 3. dlq-spike-alert — hourly pg_cron job that counts DLQ failures in the
--    last hour and POSTs an alert webhook if over threshold.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, cron
-- unschedule-then-schedule. Cron scaffolding modelled on
-- 20260515170000_storage_cleanup_weekly.sql.
-- ============================================================

BEGIN;

-- ── 1. account_id column + index ─────────────────────────────
ALTER TABLE public.dead_letter_jobs
  ADD COLUMN IF NOT EXISTS account_id uuid;

CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_account_id
  ON public.dead_letter_jobs (account_id);

-- ── 2. Requeue RPC ───────────────────────────────────────────
-- For each DLQ row in p_ids: insert a fresh pending video_generation_jobs
-- row carrying the original task_type/payload/user_id/account_id/project_id,
-- then delete the DLQ row. Returns the count of jobs requeued.
--
-- SECURITY DEFINER + pinned search_path. Granted to service_role ONLY
-- (admin/back-office tooling calls this with the service key; never exposed
-- to anon or authenticated client callers).
CREATE OR REPLACE FUNCTION public.api_requeue_dead_letter(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer := 0;
  v_row   public.dead_letter_jobs%ROWTYPE;
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT * FROM public.dead_letter_jobs
    WHERE id = ANY(p_ids)
    FOR UPDATE
  LOOP
    -- Per-row subtransaction so ONE un-requeuable row (null user_id →
    -- not_null_violation, or a deleted project_id → foreign_key_violation,
    -- since video_generation_jobs.user_id is NOT NULL and project_id FKs to
    -- projects ON DELETE CASCADE) doesn't abort the whole batch.
    BEGIN
      INSERT INTO public.video_generation_jobs (
        status,
        task_type,
        payload,
        user_id,
        account_id,
        project_id
      ) VALUES (
        'pending',
        v_row.task_type,
        v_row.payload,
        v_row.user_id,
        v_row.account_id,
        -- Null out a project_id whose project no longer exists (avoids the FK
        -- abort); the column is nullable for API/headless jobs.
        (SELECT p.id FROM public.projects p WHERE p.id = v_row.project_id)
      );

      DELETE FROM public.dead_letter_jobs WHERE id = v_row.id;

      v_count := v_count + 1;
    EXCEPTION WHEN foreign_key_violation OR not_null_violation THEN
      -- Leave the offending DLQ row in place; do not count it.
      RAISE NOTICE 'api_requeue_dead_letter: skipped DLQ row % (%)', v_row.id, SQLERRM;
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.api_requeue_dead_letter(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_requeue_dead_letter(uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.api_requeue_dead_letter(uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.api_requeue_dead_letter(uuid[]) TO service_role;

-- ── 3. DLQ-spike alert cron ──────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$ BEGIN
  -- Idempotent: drop a prior binding before rebinding.
  BEGIN PERFORM cron.unschedule('dlq-spike-alert');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

-- Hourly: count DLQ rows that failed in the last hour and, if over threshold
-- (20), POST an alert. The webhook URL is read from Vault, NOT an app.* GUC —
-- migration 20260518200100 documents that app.* GUCs are unavailable on this
-- Supabase project (ALTER DATABASE for the app.* prefix is denied to the owner
-- role and the GUCs vanish on config resets), so it moved every http cron onto
-- Vault secrets. We follow that pattern. If the secret is unset the alert is
-- skipped (guarded), and the DO block below nudges the operator to set it.
-- failed_at falls back to created_at for rows where it is NULL.
SELECT cron.schedule(
  'dlq-spike-alert',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets
              WHERE name = 'dlq_alert_webhook_url' LIMIT 1),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'text',
      'DLQ spike: ' || cnt || ' jobs dead-lettered in the last hour (threshold 20).',
      'dlq_failures_last_hour', cnt,
      'threshold', 20
    )
  )
  FROM (
    SELECT count(*) AS cnt
    FROM public.dead_letter_jobs
    WHERE COALESCE(failed_at, created_at) >= now() - interval '1 hour'
  ) s
  WHERE s.cnt > 20
    AND (SELECT decrypted_secret FROM vault.decrypted_secrets
           WHERE name = 'dlq_alert_webhook_url' LIMIT 1) IS NOT NULL
  $$
);

-- Operator nudge: until the Vault secret exists, the alert cannot fire.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'dlq_alert_webhook_url'
  ) THEN
    RAISE NOTICE 'Vault secret dlq_alert_webhook_url is NOT set — the dlq-spike-alert cron will not fire until you run, ONCE, from the dashboard SQL Editor: SELECT vault.create_secret(''<webhook_url>'', ''dlq_alert_webhook_url'');';
  END IF;
END $$;

COMMIT;
