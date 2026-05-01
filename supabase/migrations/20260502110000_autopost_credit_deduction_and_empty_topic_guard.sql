-- ============================================================
-- autopost_tick + autopost_fire_now:
--   1. Empty-topic-pool guard
--   2. Credit deduction at run kickoff
--
-- Without these the cron driver and Run-now RPC happily fired
-- "topicless" runs whenever topic_pool was empty, AND every successful
-- generation was free (the worker's refundCreditsOnFailure path was
-- the only credit accounting in the autopost flow, and it refunded
-- against a phantom upfront deduction that never happened).
--
-- Both functions now:
--   * Resolve the topic.
--   * If topic IS NULL AND the pool is empty, RAISE NOTICE and skip
--     this schedule entirely — no run row, no render job, no charge.
--   * Compute credits_required from config_snapshot.length and
--     config_snapshot.mode using the same LENGTH×PRODUCT_MULT formula
--     the frontend uses (planLimits.ts/getCreditsRequired). Default
--     to length='short' / mode='smartflow' (the same fallback the
--     orchestrator uses when config_snapshot is absent).
--   * Insert the autopost_runs row first (so we have a run id to
--     correlate logs with).
--   * Call public.deduct_credits_securely. On FALSE balance, mark the
--     run failed with error_summary='Insufficient credits' and DO
--     NOT enqueue the render job. The schedule's next_fire_at has
--     already moved forward (tick) or never moved (fire_now), which
--     is the correct behavior — we don't want to chase missed slots
--     once the user is out of credits.
--   * On TRUE, enqueue the autopost_render job and stamp
--     payload.creditsDeducted so refundCreditsOnFailure can refund
--     the exact amount.
--
-- The deduct call uses an idempotency_key bound to the run id, so a
-- retried tick that re-enters this code path for the same run won't
-- double-charge. (autopost_tick wraps each schedule in its own
-- BEGIN/EXCEPTION, so a deduct on attempt N+1 after attempt N partially
-- failed is benign as long as the key is the same.)
-- ============================================================

-- Inline credit-cost helper. Mirrors src/lib/planLimits.ts so the SQL
-- and the frontend agree on credits_required for any given length+mode.
-- IMMUTABLE so the planner can fold it into the surrounding statement.
CREATE OR REPLACE FUNCTION public.autopost_credits_required(
  p_mode   TEXT,
  p_length TEXT
)
RETURNS INT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  secs NUMERIC;
  mult NUMERIC;
BEGIN
  -- Length → estimated seconds. Defaults to 'short' for unknown values.
  secs := CASE COALESCE(p_length, 'short')
    WHEN 'short'        THEN 150
    WHEN 'brief'        THEN 280
    WHEN 'presentation' THEN 360
    ELSE                     150
  END;
  -- Mode → product multiplier.
  mult := CASE COALESCE(p_mode, 'smartflow')
    WHEN 'doc2video'  THEN 1
    WHEN 'smartflow'  THEN 0.5
    WHEN 'cinematic'  THEN 5
    ELSE                  1
  END;
  RETURN CEIL(secs * mult)::INT;
END;
$$;

COMMENT ON FUNCTION public.autopost_credits_required(TEXT, TEXT)
  IS 'Mirrors src/lib/planLimits.ts:getCreditsRequired. Returns credits-per-run for a given mode + length. Used by autopost_tick and autopost_fire_now for upfront deduction.';


-- ============================================================
-- autopost_tick: per-minute pg_cron driver, now with credit
-- deduction and empty-pool guard.
-- ============================================================

CREATE OR REPLACE FUNCTION public.autopost_tick()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  enabled         BOOLEAN;
  s               public.autopost_schedules%ROWTYPE;
  next_fire       TIMESTAMPTZ;
  topic           TEXT;
  resolved        TEXT;
  new_run_id      UUID;
  new_job_id      UUID;
  cfg             JSONB;
  cfg_mode        TEXT;
  cfg_length      TEXT;
  credits_needed  INT;
  deduct_ok       BOOLEAN;
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
      next_fire := public.autopost_advance_next_fire(
        s.cron_expression,
        GREATEST(s.next_fire_at, NOW()),
        s.timezone
      );

      UPDATE public.autopost_schedules
         SET next_fire_at = next_fire
       WHERE id = s.id;

      topic := public.autopost_resolve_topic(s);

      -- Empty-topic-pool guard. The autopost_resolve_topic helper
      -- returns NULL when topic_pool is empty/null; in that case the
      -- card already shows "Out of topics" but the tick used to fire
      -- a topicless run anyway. Skip cleanly.
      IF topic IS NULL AND COALESCE(array_length(s.topic_pool, 1), 0) = 0 THEN
        RAISE NOTICE 'autopost_tick: schedule % skipped — topic_pool empty', s.id;
        new_run_id := NULL;
        new_job_id := NULL;
        CONTINUE;
      END IF;

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

      -- Compute credits required from the frozen config_snapshot. Falls
      -- back to short/smartflow when fields are missing (older rows).
      cfg        := COALESCE(s.config_snapshot, '{}'::jsonb);
      cfg_mode   := COALESCE(cfg->>'mode',   'smartflow');
      cfg_length := COALESCE(cfg->>'length', 'short');
      credits_needed := public.autopost_credits_required(cfg_mode, cfg_length);

      -- Deduct credits BEFORE enqueueing the render job. Idempotency
      -- key bound to run id prevents double-charges on a retried
      -- subtransaction.
      deduct_ok := public.deduct_credits_securely(
        s.user_id,
        credits_needed,
        'autopost_run',
        format('Autopost run %s (schedule %s)', new_run_id, s.id),
        format('autopost_run:%s', new_run_id)
      );

      IF NOT deduct_ok THEN
        UPDATE public.autopost_runs
           SET status        = 'failed',
               error_summary = 'Insufficient credits'
         WHERE id = new_run_id;
        RAISE NOTICE 'autopost_tick: schedule % failed — insufficient credits (needed %)', s.id, credits_needed;
        new_run_id := NULL;
        new_job_id := NULL;
        CONTINUE;
      END IF;

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
          'creditsDeducted',  credits_needed,
          'projectType',      cfg_mode,
          'length',           cfg_length
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
  IS 'Per-minute pg_cron driver. Skips when autopost_enabled=false, no schedules are due, OR topic_pool is empty. Deducts credits via deduct_credits_securely before enqueueing the render job; insufficient balance marks the run failed with error_summary=''Insufficient credits''.';


-- ============================================================
-- autopost_fire_now: manual Run-now RPC, mirrors autopost_tick body
-- with the same credit + empty-pool guard.
-- ============================================================

CREATE OR REPLACE FUNCTION public.autopost_fire_now(p_schedule_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  caller_id       UUID := auth.uid();
  s               public.autopost_schedules%ROWTYPE;
  topic           TEXT;
  resolved        TEXT;
  new_run_id      UUID;
  new_job_id      UUID;
  cfg             JSONB;
  cfg_mode        TEXT;
  cfg_length      TEXT;
  credits_needed  INT;
  deduct_ok       BOOLEAN;
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

  topic := public.autopost_resolve_topic(s);

  -- Empty-topic-pool guard — refuse to fire a topicless run.
  IF topic IS NULL AND COALESCE(array_length(s.topic_pool, 1), 0) = 0 THEN
    RAISE NOTICE 'autopost_fire_now: schedule % skipped — topic_pool empty', s.id;
    RAISE EXCEPTION 'autopost_fire_now: topic pool is empty — generate topics before firing'
      USING ERRCODE = '22023';
  END IF;

  resolved := public.autopost_resolve_prompt(
    s.prompt_template, topic, NOW(), COALESCE(s.timezone, 'UTC')
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

  cfg        := COALESCE(s.config_snapshot, '{}'::jsonb);
  cfg_mode   := COALESCE(cfg->>'mode',   'smartflow');
  cfg_length := COALESCE(cfg->>'length', 'short');
  credits_needed := public.autopost_credits_required(cfg_mode, cfg_length);

  deduct_ok := public.deduct_credits_securely(
    s.user_id,
    credits_needed,
    'autopost_run',
    format('Autopost run %s (schedule %s)', new_run_id, s.id),
    format('autopost_run:%s', new_run_id)
  );

  IF NOT deduct_ok THEN
    UPDATE public.autopost_runs
       SET status        = 'failed',
           error_summary = 'Insufficient credits'
     WHERE id = new_run_id;
    -- Surface the failure to the caller so the UI shows a real error,
    -- not just a quietly-failed run row.
    RAISE EXCEPTION 'autopost_fire_now: insufficient credits (% needed)', credits_needed
      USING ERRCODE = '53400';
  END IF;

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
      'creditsDeducted',  credits_needed,
      'projectType',      cfg_mode,
      'length',           cfg_length
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
  IS 'Manual Run-now trigger. Mirrors autopost_tick''s per-schedule body: empty-pool guard, credit deduction via deduct_credits_securely, render job enqueue. Caller must own the schedule and be an admin.';
