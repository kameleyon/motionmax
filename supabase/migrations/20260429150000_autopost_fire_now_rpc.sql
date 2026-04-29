-- ============================================================
-- autopost_fire_now(p_schedule_id) — shared kickoff RPC
--
-- Both pg_cron's autopost_tick() and the user-driven "Run now" button
-- need to do the SAME thing: pick the next topic round-robin, resolve
-- the prompt, insert an autopost_runs row, and enqueue a
-- video_generation_jobs(task_type='autopost_render') for the worker.
--
-- Before this migration the cron path did it inline in autopost_tick
-- and Run-now POSTed to a Vercel Function that 500-ed at the platform
-- layer. Centralising the logic in a SECURITY DEFINER RPC lets both
-- callers share one implementation without granting the browser write
-- access to video_generation_jobs.
--
-- Authorisation: caller must be the schedule owner AND an admin. We
-- check inside the function (not via RLS) because SECURITY DEFINER
-- bypasses RLS by design — without these checks the function would let
-- any authenticated user fire any schedule.
--
-- Returns the new autopost_runs.id so the client can navigate or poll
-- by run id without a follow-up query.
--
-- This migration also drops the NOT NULL constraint on
-- autopost_schedules.duration_seconds. The column stays for backwards
-- compatibility with older dashboards and the credit estimate, but the
-- worker pipeline picks duration from the flow's natural structure
-- (length='short' vs 'presentation' inside config_snapshot), not from
-- this column. Forcing it to "30" gave the wrong impression that the
-- system caps every video at 30 seconds.
-- ============================================================

ALTER TABLE public.autopost_schedules
  ALTER COLUMN duration_seconds DROP NOT NULL,
  ALTER COLUMN duration_seconds DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.autopost_fire_now(p_schedule_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  caller_id   UUID := auth.uid();
  s           public.autopost_schedules%ROWTYPE;
  topic       TEXT;
  resolved    TEXT;
  new_run_id  UUID;
  new_job_id  UUID;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'autopost_fire_now: not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(caller_id) THEN
    RAISE EXCEPTION 'autopost_fire_now: admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO s FROM public.autopost_schedules WHERE id = p_schedule_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'autopost_fire_now: schedule not found' USING ERRCODE = '02000';
  END IF;

  IF s.user_id <> caller_id THEN
    RAISE EXCEPTION 'autopost_fire_now: caller does not own schedule' USING ERRCODE = '42501';
  END IF;

  topic    := public.autopost_resolve_topic(s);
  resolved := public.autopost_resolve_prompt(s.prompt_template, topic, NOW(), COALESCE(s.timezone, 'UTC'));
  IF resolved IS NOT NULL THEN
    resolved := replace(resolved, '{schedule_name}', s.name);
  END IF;

  INSERT INTO public.autopost_runs (
    schedule_id, fired_at, topic, prompt_resolved, status
  ) VALUES (
    s.id, NOW(), topic, COALESCE(resolved, ''), 'queued'
  )
  RETURNING id INTO new_run_id;

  INSERT INTO public.video_generation_jobs (
    user_id, task_type, status, payload
  ) VALUES (
    s.user_id,
    'autopost_render',
    'pending',
    jsonb_build_object(
      'autopost_run_id',  new_run_id,
      'prompt',           resolved,
      'motion_preset',    s.motion_preset,
      'duration_seconds', s.duration_seconds,
      'resolution',       s.resolution
    )
  )
  RETURNING id INTO new_job_id;

  UPDATE public.autopost_runs
     SET video_job_id = new_job_id,
         status       = 'generating'
   WHERE id = new_run_id;

  RETURN new_run_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.autopost_fire_now(UUID) TO authenticated;

COMMENT ON FUNCTION public.autopost_fire_now(UUID)
  IS 'Manual Run-now trigger. Mirrors autopost_tick''s per-schedule body. Returns the new autopost_runs.id. Caller must own the schedule and be an admin.';
