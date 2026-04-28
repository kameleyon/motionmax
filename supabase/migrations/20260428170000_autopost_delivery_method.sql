-- Migration: autopost_delivery_method
--
-- Adds support for three delivery modes on autopost_schedules:
--   * 'social'       — fan out to connected platforms (existing path)
--   * 'email'        — queue an email-delivery worker job per render
--   * 'library_only' — leave the rendered video in run history; nothing else
--
-- Why: school/work/personal-library users want to schedule generations
-- without ever connecting a YouTube/IG/TikTok account. The current trigger
-- assumes target_account_ids is non-empty and stalls runs forever otherwise.
-- This migration loosens that assumption and replaces the trigger with one
-- that branches on the new delivery_method column.

-- ── Column additions ────────────────────────────────────────────────
ALTER TABLE public.autopost_schedules
  ADD COLUMN IF NOT EXISTS delivery_method TEXT NOT NULL DEFAULT 'social',
  ADD COLUMN IF NOT EXISTS email_recipients TEXT[] DEFAULT '{}'::text[];

-- ── Constrain delivery_method to the three known values ─────────────
DO $$
BEGIN
  ALTER TABLE public.autopost_schedules
    ADD CONSTRAINT autopost_schedules_delivery_method_check
    CHECK (delivery_method IN ('social', 'email', 'library_only'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

-- ── Allow target_account_ids to be empty ─────────────────────────────
-- Original schema marked it NOT NULL with no default. Email and library
-- modes never populate it, so drop NOT NULL. We keep a default of '{}'
-- so existing inserts that omit the column don't trip a not-null error.
ALTER TABLE public.autopost_schedules
  ALTER COLUMN target_account_ids DROP NOT NULL;

ALTER TABLE public.autopost_schedules
  ALTER COLUMN target_account_ids SET DEFAULT '{}'::uuid[];

-- ── Replace the render-completed trigger to handle all three modes ──
-- The old version unconditionally fanned out into autopost_publish_jobs
-- via target_account_ids. If empty, nothing was inserted and the run
-- sat in 'publishing' forever (no publish_jobs ever moved → dispatcher
-- never called maybeCompleteRun).
--
-- New behaviour:
--   social        → existing fan-out (only if target_account_ids non-empty)
--   email         → enqueue a video_generation_jobs row of type
--                   'autopost_email_delivery' that the worker picks up
--                   and uses the Resend API to mail recipients
--   library_only  → straight to 'completed', no further work
--   social-with-no-accounts / email-with-no-recipients fall through to
--   'completed' as a last-resort safety so we never leave runs stuck.

CREATE OR REPLACE FUNCTION public.autopost_on_video_completed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  run_id UUID;
  sched  public.autopost_schedules%ROWTYPE;
BEGIN
  IF NEW.status = 'completed'
     AND OLD.status IS DISTINCT FROM 'completed'
     AND (NEW.payload->>'autopost_run_id') IS NOT NULL
  THEN
    run_id := (NEW.payload->>'autopost_run_id')::UUID;

    -- Look up the schedule that owns this run.
    SELECT s.* INTO sched
      FROM public.autopost_schedules s
      JOIN public.autopost_runs r ON r.schedule_id = s.id
     WHERE r.id = run_id;

    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    -- Always advance to 'rendered' first; later branches may push past it.
    UPDATE public.autopost_runs
       SET status = 'rendered'
     WHERE id = run_id;

    IF sched.delivery_method = 'social'
       AND sched.target_account_ids IS NOT NULL
       AND array_length(sched.target_account_ids, 1) > 0
    THEN
      -- Existing social fan-out path.
      INSERT INTO public.autopost_publish_jobs (
        run_id, social_account_id, platform, status, scheduled_for
      )
      SELECT
        run_id,
        sa.id,
        sa.platform,
        'pending',
        NOW()
        FROM unnest(sched.target_account_ids) AS target_id
        JOIN public.autopost_social_accounts sa ON sa.id = target_id;

      UPDATE public.autopost_runs
         SET status = 'publishing'
       WHERE id = run_id;

    ELSIF sched.delivery_method = 'email'
          AND sched.email_recipients IS NOT NULL
          AND array_length(sched.email_recipients, 1) > 0
    THEN
      -- Queue a worker email-delivery job. The worker picks it up,
      -- signs the rendered video URL, and POSTs to the Resend API.
      INSERT INTO public.video_generation_jobs (
        user_id, task_type, payload, status
      ) VALUES (
        sched.user_id,
        'autopost_email_delivery',
        jsonb_build_object(
          'autopost_run_id', run_id,
          'recipients',      sched.email_recipients,
          'video_job_id',    NEW.id
        ),
        'pending'
      );

      UPDATE public.autopost_runs
         SET status = 'publishing'
       WHERE id = run_id;

    ELSE
      -- library_only OR misconfigured (social-with-no-accounts /
      -- email-with-no-recipients). The video is already in run history;
      -- the run is done.
      UPDATE public.autopost_runs
         SET status = 'completed'
       WHERE id = run_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.autopost_on_video_completed()
  IS 'AFTER UPDATE trigger on video_generation_jobs: branches on the schedule''s delivery_method (social | email | library_only) when an autopost_render job completes.';

-- Trigger itself was already created in 20260428130000 and points at the
-- function by name, so the CREATE OR REPLACE above is sufficient.
