-- B-NEW-8 (Herald) — Lifecycle email drip schedule.
--
-- Problem (audit, Wave 4): MotionMax sends a single day-0 welcome and
-- nothing else. The lifecycle gap means:
--   • New signups never get day-1/3/7/14 onboarding nudges, so first-
--     project conversion stalls in the long tail of "I'll come back".
--   • Dormant users (30/60d) get no win-back, so we lose them silently.
--   • Stripe's unbranded receipt is the only proof-of-purchase, which
--     looks off-brand and competes with our own inbox real estate.
--
-- Fix:
--   1) `email_drip_schedule` — durable schedule of all non-immediate
--      lifecycle emails. Cron drains it; one row per (user_id, drip_type)
--      so re-runs are idempotent. Status field tracks send/skip outcome.
--   2) pg_cron job `run-email-drips` (every 15 min) drains the queue.
--   3) pg_cron job `dormant-user-detector` (daily) inserts winback_30
--      and winback_60 rows for users whose last_sign_in_at exceeds
--      29/59 days respectively. ON CONFLICT DO NOTHING keeps re-runs
--      safe — a user only ever gets each drip type once.
--
-- The day-0 welcome stays in notify-signup-welcome (immediate); that
-- function is extended to ALSO insert four pending rows here for the
-- day-1/3/7/14 nudges.
--
-- RLS: service-role-only. End users never read or write this table —
-- it's a system queue, not user-owned data.

-- ── 1. Table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_drip_schedule (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  drip_type       TEXT         NOT NULL CHECK (drip_type IN (
                    'day_1', 'day_3', 'day_7', 'day_14',
                    'winback_30', 'winback_60'
                  )),
  scheduled_at    TIMESTAMPTZ  NOT NULL,
  sent_at         TIMESTAMPTZ  NULL,
  status          TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending', 'sent', 'failed',
                    'skipped_unsubscribed', 'skipped_inactive'
                  )),
  error_message   TEXT         NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT email_drip_schedule_user_type_unique UNIQUE (user_id, drip_type)
);

COMMENT ON TABLE public.email_drip_schedule IS
  'B-NEW-8: queue for lifecycle drip emails (day_1/3/7/14, winback_30/60). '
  'Drained by run-email-drips edge fn on a 15-min cron. Service-role-only RLS.';

-- Indexes
-- Picker index — the cron worker scans pending rows whose scheduled_at
-- has come due. Partial-on-status keeps it tiny in steady state.
CREATE INDEX IF NOT EXISTS email_drip_schedule_pending_due_idx
  ON public.email_drip_schedule (scheduled_at)
  WHERE status = 'pending';

-- Per-user lookup — used by the dormant detector to skip users who
-- already have a winback row, and by support to inspect a user's drip
-- history. Composite so DISTINCT ON (user_id, drip_type) orders cheaply.
CREATE INDEX IF NOT EXISTS email_drip_schedule_user_idx
  ON public.email_drip_schedule (user_id, drip_type);

-- ── 2. RLS — service role only ────────────────────────────────────────
ALTER TABLE public.email_drip_schedule ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, but we add an explicit deny-all-other policy
-- so future "anon read" mistakes can't leak the schedule. Pattern matches
-- B-NEW-5 hardening on system-managed queues.
DROP POLICY IF EXISTS "email_drip_schedule_no_user_access" ON public.email_drip_schedule;
CREATE POLICY "email_drip_schedule_no_user_access"
  ON public.email_drip_schedule
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

-- ── 3. Cron: run-email-drips (every 15 min) ───────────────────────────
-- Mirror of the schedule-deletion-drain pattern in
-- 20260419000020_schedule_deletion_drain.sql. Requires pg_cron + pg_net
-- and the `app.supabase_url` / `app.service_role_key` GUCs that B-NEW-6
-- already set up.
SELECT cron.schedule(
  'run-email-drips',
  '*/15 * * * *',
  $$SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/run-email-drips',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key')),
    body := '{}'::jsonb
  )$$
);

-- ── 4. Cron: dormant-user-detector (daily, 09:00 UTC) ─────────────────
-- Schedules winback_30 / winback_60 drip rows for users whose last
-- sign-in exceeds the threshold. ON CONFLICT (user_id, drip_type) DO
-- NOTHING means re-runs are idempotent — a user gets each winback at
-- most once in their lifetime, even if they go dormant repeatedly.
--
-- Why a daily cron instead of an UPDATE trigger:
--   • Postgres has no "trigger when N days pass without an update".
--   • A trigger fires on a write, but dormancy is the absence of writes.
--   • A daily scan is cheap (indexed last_sign_in_at), idempotent, and
--     observable in cron.job_run_details.
--
-- Threshold rationale:
--   • winback_30: last_sign_in_at < now() - 29 days  (sent on day 30)
--   • winback_60: last_sign_in_at < now() - 59 days  (sent on day 60)
-- Off-by-one buffer (29/59) gives the daily cron a 24h window to fire
-- on the right day even if it slips a few hours.
CREATE OR REPLACE FUNCTION public.detect_dormant_users_and_schedule_winbacks()
RETURNS TABLE (drip_type text, inserted_count int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE
  v_winback_30_count int;
  v_winback_60_count int;
BEGIN
  -- winback_30 — schedule immediately for users last seen 29-58d ago
  -- and not unsubscribed and not soft-deleted.
  WITH inserted AS (
    INSERT INTO public.email_drip_schedule (user_id, drip_type, scheduled_at, status)
    SELECT u.id, 'winback_30', now(), 'pending'
      FROM auth.users u
      JOIN public.profiles p ON p.user_id = u.id
     WHERE u.last_sign_in_at IS NOT NULL
       AND u.last_sign_in_at < now() - interval '29 days'
       AND u.last_sign_in_at >= now() - interval '58 days'
       AND p.deleted_at IS NULL
       AND p.newsletter_unsubscribed_at IS NULL
    ON CONFLICT (user_id, drip_type) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_winback_30_count FROM inserted;

  -- winback_60 — schedule immediately for users last seen 59+d ago.
  WITH inserted AS (
    INSERT INTO public.email_drip_schedule (user_id, drip_type, scheduled_at, status)
    SELECT u.id, 'winback_60', now(), 'pending'
      FROM auth.users u
      JOIN public.profiles p ON p.user_id = u.id
     WHERE u.last_sign_in_at IS NOT NULL
       AND u.last_sign_in_at < now() - interval '59 days'
       AND p.deleted_at IS NULL
       AND p.newsletter_unsubscribed_at IS NULL
    ON CONFLICT (user_id, drip_type) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_winback_60_count FROM inserted;

  RETURN QUERY VALUES
    ('winback_30', v_winback_30_count),
    ('winback_60', v_winback_60_count);
END;
$func$;

REVOKE ALL ON FUNCTION public.detect_dormant_users_and_schedule_winbacks() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_dormant_users_and_schedule_winbacks() TO service_role;

-- Schedule the daily detector. 09:00 UTC = 02:00 PT — quiet hours, low
-- contention with end-of-day reporting jobs.
SELECT cron.schedule(
  'dormant-user-detector',
  '0 9 * * *',
  $$SELECT public.detect_dormant_users_and_schedule_winbacks()$$
);
