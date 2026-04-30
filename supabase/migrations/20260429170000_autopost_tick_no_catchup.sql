-- ============================================================
-- autopost_tick: stop catch-up storms on unpause / long pauses.
--
-- Bug: when a schedule was paused (active=false) the tick skipped it,
-- so next_fire_at never advanced. After unpausing, autopost_tick saw
-- the schedule as "due" because next_fire_at was hours/days in the
-- past. It fired the run and called autopost_advance_next_fire from
-- the stale past cursor — which returned the NEXT cron slot after
-- that past value, often STILL in the past. Result: one fire per
-- per-minute tick until next_fire_at caught up to wall-clock, racking
-- up four runs in four minutes for an "every hour" schedule paused
-- for four hours.
--
-- Fix: pass GREATEST(s.next_fire_at, NOW()) to the cron advancer so
-- the cursor always starts at *at least* the present moment. The
-- schedule fires once on unpause (because its previous next_fire_at
-- was past, so it was due), then the new next_fire_at is the first
-- valid cron slot strictly AFTER NOW. No chase, no storm — the
-- standard "missed deadlines are skipped, not replayed" semantics.
--
-- Everything else in the function is unchanged. Re-creating it via
-- CREATE OR REPLACE keeps the existing pg_cron registration valid
-- (cron.schedule references the function name, not its body).
-- ============================================================

CREATE OR REPLACE FUNCTION public.autopost_tick()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  enabled        BOOLEAN;
  s              public.autopost_schedules%ROWTYPE;
  next_fire      TIMESTAMPTZ;
  topic          TEXT;
  resolved       TEXT;
  new_run_id     UUID;
  new_job_id     UUID;
BEGIN
  SELECT (value::TEXT)::BOOLEAN
    INTO enabled
    FROM public.app_settings
   WHERE key = 'autopost_enabled';
  IF NOT COALESCE(enabled, FALSE) THEN
    RETURN;
  END IF;

  FOR s IN
    SELECT *
      FROM public.autopost_schedules
     WHERE active = TRUE
       AND next_fire_at <= NOW()
     ORDER BY next_fire_at ASC
  LOOP
    BEGIN
      -- Always advance from NOW (or later) so a stale past cursor
      -- can't chain into multiple catch-up fires. This guarantees the
      -- new next_fire_at is strictly in the future regardless of how
      -- long the schedule was paused.
      next_fire := public.autopost_advance_next_fire(
        s.cron_expression,
        GREATEST(s.next_fire_at, NOW()),
        s.timezone
      );

      UPDATE public.autopost_schedules
         SET next_fire_at = next_fire
       WHERE id = s.id;

      topic    := public.autopost_resolve_topic(s);
      resolved := public.autopost_resolve_prompt(
        s.prompt_template, topic, NOW(), s.timezone
      );
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

    EXCEPTION WHEN OTHERS THEN
      IF new_run_id IS NOT NULL THEN
        UPDATE public.autopost_runs
           SET status        = 'failed',
               error_summary = SQLERRM
         WHERE id = new_run_id;
      END IF;
      RAISE NOTICE 'autopost_tick: schedule % failed: %', s.id, SQLERRM;
    END;

    new_run_id := NULL;
    new_job_id := NULL;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.autopost_tick()
  IS 'Per-minute pg_cron driver. Skips when autopost_enabled=false or no schedules due. Advances next_fire_at from GREATEST(next_fire_at, NOW()) so a paused schedule fires at most once on unpause regardless of how long it was paused.';
