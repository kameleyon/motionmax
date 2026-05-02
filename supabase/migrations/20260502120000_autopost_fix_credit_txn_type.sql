-- Fix: credit_transactions check constraint rejects 'autopost_run'.
--
-- The 20260501150000 migration deducted credits with
--   p_transaction_type := 'autopost_run'
-- which is not in the credit_transactions_transaction_type_check
-- enum. Allowed values are: purchase, usage, generation,
-- video_generation, subscription_grant, refund, refund_clawback,
-- adjustment, signup_bonus, daily_bonus.
--
-- Autopost runs are scheduled video generations, so 'video_generation'
-- is the right semantic match. Re-apply both functions with the
-- corrected type. Bodies are otherwise identical to 20260501150000.

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
  cfg         JSONB;
  cost        INT;
  ok          BOOLEAN;
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

  IF NOT public.is_creator_or_studio(s.user_id) THEN
    RAISE EXCEPTION 'autopost_fire_now: autopost requires the Creator or Studio plan' USING ERRCODE = '42501';
  END IF;

  topic := public.autopost_resolve_topic(s);
  IF topic IS NULL AND COALESCE(array_length(s.topic_pool, 1), 0) = 0 THEN
    RAISE EXCEPTION 'autopost_fire_now: no topics in queue — generate or add topics first' USING ERRCODE = '02000';
  END IF;

  resolved := public.autopost_resolve_prompt(s.prompt_template, topic, NOW(), COALESCE(s.timezone, 'UTC'));
  IF resolved IS NOT NULL THEN
    resolved := replace(resolved, '{schedule_name}', s.name);
  END IF;

  cfg  := COALESCE(s.config_snapshot, '{}'::jsonb);
  cost := public.autopost_credits_required(
    COALESCE(cfg->>'mode',   'smartflow'),
    COALESCE(cfg->>'length', 'short')
  );

  SELECT public.deduct_credits_securely(
    p_user_id          := s.user_id,
    p_amount           := cost,
    p_transaction_type := 'video_generation',
    p_description      := 'Autopost run: ' || COALESCE(topic, s.name)
  ) INTO ok;

  IF NOT ok THEN
    INSERT INTO public.autopost_runs (
      schedule_id, fired_at, topic, prompt_resolved, status, error_summary
    ) VALUES (
      s.id, NOW(), topic, COALESCE(resolved, ''), 'failed', 'Insufficient credits'
    )
    RETURNING id INTO new_run_id;
    RAISE EXCEPTION 'autopost_fire_now: insufficient credits (need %)', cost USING ERRCODE = '53400';
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
      'resolution',       s.resolution,
      'creditsDeducted',  cost
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
  cfg            JSONB;
  cost           INT;
  ok             BOOLEAN;
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
      IF NOT public.is_creator_or_studio(s.user_id) THEN
        next_fire := public.autopost_advance_next_fire(
          s.cron_expression,
          GREATEST(s.next_fire_at, NOW()),
          s.timezone
        );
        UPDATE public.autopost_schedules
           SET next_fire_at = next_fire
         WHERE id = s.id;
        RAISE NOTICE 'autopost_tick: skipping schedule % — owner not on Creator/Studio plan', s.id;
        new_run_id := NULL;
        new_job_id := NULL;
        CONTINUE;
      END IF;

      next_fire := public.autopost_advance_next_fire(
        s.cron_expression,
        GREATEST(s.next_fire_at, NOW()),
        s.timezone
      );
      UPDATE public.autopost_schedules
         SET next_fire_at = next_fire
       WHERE id = s.id;

      topic := public.autopost_resolve_topic(s);

      IF topic IS NULL AND COALESCE(array_length(s.topic_pool, 1), 0) = 0 THEN
        RAISE NOTICE 'autopost_tick: schedule % has empty topic pool — skipping', s.id;
        CONTINUE;
      END IF;

      resolved := public.autopost_resolve_prompt(
        s.prompt_template, topic, NOW(), s.timezone
      );
      IF resolved IS NOT NULL THEN
        resolved := replace(resolved, '{schedule_name}', s.name);
      END IF;

      cfg  := COALESCE(s.config_snapshot, '{}'::jsonb);
      cost := public.autopost_credits_required(
        COALESCE(cfg->>'mode',   'smartflow'),
        COALESCE(cfg->>'length', 'short')
      );

      SELECT public.deduct_credits_securely(
        p_user_id          := s.user_id,
        p_amount           := cost,
        p_transaction_type := 'video_generation',
        p_description      := 'Autopost run: ' || COALESCE(topic, s.name)
      ) INTO ok;

      IF NOT ok THEN
        INSERT INTO public.autopost_runs (
          schedule_id, fired_at, topic, prompt_resolved, status, error_summary
        ) VALUES (
          s.id, NOW(), topic, COALESCE(resolved, ''), 'failed', 'Insufficient credits'
        )
        RETURNING id INTO new_run_id;
        RAISE NOTICE 'autopost_tick: schedule % failed deduction (insufficient credits)', s.id;
        new_run_id := NULL;
        new_job_id := NULL;
        CONTINUE;
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
          'resolution',       s.resolution,
          'creditsDeducted',  cost
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
