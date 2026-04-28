-- Migration: autopost_tick_and_triggers
--
-- Wave 2b of the Autopost feature build (per AUTOPOST_PLAN.md §3 + §6 and
-- AUTOPOST_ROADMAP.md Phase 6). Adds the Postgres machinery that turns a
-- pg_cron tick into autopost runs + queued render jobs, plus the
-- render-completed trigger that fans out per-target publish jobs.
--
-- Pieces, in order:
--   1. autopost_resolve_topic(schedule_row)        - round-robin topic picker
--   2. autopost_resolve_prompt(template, ...)      - template substitution
--   3. autopost_advance_next_fire(cron, ts, tz)    - 5-field cron parser
--   4. autopost_tick()                              - SECURITY DEFINER per-minute driver
--   5. autopost_on_video_completed                  - render-completed trigger
--   6. cron.schedule('autopost-tick', ...)          - register the per-minute job
--
-- All objects use CREATE OR REPLACE / DROP-then-CREATE so the migration
-- is idempotent. The DO $$ ... $$ assertion blocks at the bottom of the
-- cron-parser section will abort the migration if the parser produces a
-- wrong answer for known fixtures.

-- ============================================================
-- 1. autopost_resolve_topic
-- ============================================================
CREATE OR REPLACE FUNCTION public.autopost_resolve_topic(schedule_row public.autopost_schedules)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  pool_len  INT;
  fire_idx  INT;
BEGIN
  IF schedule_row.topic_pool IS NULL THEN
    RETURN NULL;
  END IF;
  pool_len := array_length(schedule_row.topic_pool, 1);
  IF pool_len IS NULL OR pool_len = 0 THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO fire_idx
    FROM public.autopost_runs
   WHERE schedule_id = schedule_row.id;
  -- Postgres arrays are 1-based; (count % len) yields 0..len-1, +1 to land on a valid slot.
  RETURN schedule_row.topic_pool[(fire_idx % pool_len) + 1];
END;
$$;

COMMENT ON FUNCTION public.autopost_resolve_topic(public.autopost_schedules)
  IS 'Round-robin topic picker. Returns NULL when topic_pool is empty/null. Index = (fire_count % pool_length) + 1.';

-- ============================================================
-- 2. autopost_resolve_prompt
-- ============================================================
-- Substitutes {topic}, {date}, {day} into a template string.
-- {schedule_name} is intentionally left as-is for the caller to substitute,
-- because at the SQL layer we already have the full schedule row in scope
-- elsewhere; pulling it through this helper would force a redundant lookup.
CREATE OR REPLACE FUNCTION public.autopost_resolve_prompt(
  template  TEXT,
  topic     TEXT,
  fired_at  TIMESTAMPTZ,
  tz        TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  result    TEXT;
  date_str  TEXT;
  day_str   TEXT;
BEGIN
  IF template IS NULL THEN
    RETURN NULL;
  END IF;

  -- to_char on a timestamptz already understands the AT TIME ZONE conversion.
  date_str := to_char(fired_at AT TIME ZONE tz, 'Mon DD, YYYY');
  day_str  := TRIM(to_char(fired_at AT TIME ZONE tz, 'Day'));

  result := template;
  result := replace(result, '{topic}', COALESCE(topic, ''));
  result := replace(result, '{date}', date_str);
  result := replace(result, '{day}',  day_str);

  -- Trim any whitespace that may have been left by an empty {topic} substitution
  -- right next to other tokens, but preserve internal spacing.
  RETURN TRIM(result);
END;
$$;

COMMENT ON FUNCTION public.autopost_resolve_prompt(TEXT, TEXT, TIMESTAMPTZ, TEXT)
  IS 'Substitutes {topic}, {date}, {day} in a template. {schedule_name} is left untouched (caller substitutes).';

-- ============================================================
-- 3. autopost_advance_next_fire
-- ============================================================
-- Parses a 5-field cron expression (minute hour dom month dow) and returns
-- the FIRST matching timestamptz strictly AFTER current_fire, evaluated in
-- the supplied timezone.
--
-- Supported syntax:
--   *           every value
--   N           literal
--   N,M,...     comma list
--   A-B         inclusive range
--   */N         step over the full range
--   A-B/N       step within range
--
-- Day-of-week semantics: Postgres extract(dow ...) yields 0..6 with 0=Sun.
-- Cron also uses 0..6 with 0=Sun (and 7=Sun as an alias). We normalize 7 -> 0.
--
-- We iterate minute-by-minute in UTC space, but check field matches against
-- the *local* time after AT TIME ZONE conversion. That is what makes DST
-- transitions Just Work: a "9am M/W/F America/New_York" schedule fires at
-- 13:00 UTC during EST and at 13:00 UTC during EDT -- the local-time match
-- is unambiguous because we converted before checking.
--
-- Loop bound: 366 * 24 * 60 = 527,040 iterations. Worst case is a malformed
-- cron that never matches, in which case we raise EXCEPTION rather than
-- returning a bogus value.

CREATE OR REPLACE FUNCTION public.autopost_cron_field_match(
  field      TEXT,
  value      INT,
  field_min  INT,
  field_max  INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  part         TEXT;
  step_part    TEXT;
  range_part   TEXT;
  step_val     INT;
  lo           INT;
  hi           INT;
  cand         INT;
  pieces       TEXT[];
BEGIN
  IF field IS NULL OR field = '' THEN
    RAISE EXCEPTION 'autopost_cron_field_match: empty field';
  END IF;

  -- Split on commas first; each piece is independently OR'd.
  pieces := string_to_array(field, ',');
  FOREACH part IN ARRAY pieces LOOP
    part := TRIM(part);

    -- Pull off optional step suffix: "X/N"
    IF position('/' in part) > 0 THEN
      step_part  := split_part(part, '/', 2);
      range_part := split_part(part, '/', 1);
      step_val   := step_part::INT;
      IF step_val <= 0 THEN
        RAISE EXCEPTION 'autopost_cron_field_match: non-positive step in "%"', part;
      END IF;
    ELSE
      range_part := part;
      step_val   := 1;
    END IF;

    -- Resolve the range portion to [lo, hi].
    IF range_part = '*' THEN
      lo := field_min;
      hi := field_max;
    ELSIF position('-' in range_part) > 0 THEN
      lo := split_part(range_part, '-', 1)::INT;
      hi := split_part(range_part, '-', 2)::INT;
    ELSE
      -- Single literal. With a step, "5/15" is non-standard but we treat it
      -- as "starting at 5, step 15 up to field_max" which is what most cron
      -- impls do.
      lo := range_part::INT;
      IF step_val > 1 THEN
        hi := field_max;
      ELSE
        hi := lo;
      END IF;
    END IF;

    -- Walk lo, lo+step, lo+2*step ... <= hi and see if value lands on one.
    cand := lo;
    WHILE cand <= hi LOOP
      IF cand = value THEN
        RETURN TRUE;
      END IF;
      cand := cand + step_val;
    END LOOP;
  END LOOP;

  RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION public.autopost_cron_field_match(TEXT, INT, INT, INT)
  IS 'Internal helper: returns TRUE if `value` matches a single cron field expression.';


CREATE OR REPLACE FUNCTION public.autopost_advance_next_fire(
  cron_expr     TEXT,
  current_fire  TIMESTAMPTZ,
  tz            TEXT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  parts       TEXT[];
  f_min       TEXT;
  f_hour      TEXT;
  f_dom       TEXT;
  f_mon       TEXT;
  f_dow       TEXT;
  cand_utc    TIMESTAMPTZ;
  cand_local  TIMESTAMP;     -- local wall clock derived from cand_utc AT TIME ZONE tz
  cur_min     INT;
  cur_hour    INT;
  cur_dom     INT;
  cur_mon     INT;
  cur_dow     INT;
  iter        INT := 0;
  max_iter    INT := 366 * 24 * 60;
BEGIN
  IF cron_expr IS NULL THEN
    RAISE EXCEPTION 'autopost_advance_next_fire: cron_expr is null';
  END IF;

  -- Collapse runs of whitespace, then split.
  parts := regexp_split_to_array(TRIM(cron_expr), '\s+');
  IF array_length(parts, 1) <> 5 THEN
    RAISE EXCEPTION 'autopost_advance_next_fire: expected 5 fields, got % from "%"',
      coalesce(array_length(parts, 1), 0), cron_expr;
  END IF;

  f_min  := parts[1];
  f_hour := parts[2];
  f_dom  := parts[3];
  f_mon  := parts[4];
  f_dow  := parts[5];

  -- Snap candidate to the next whole minute strictly AFTER current_fire.
  cand_utc := date_trunc('minute', current_fire) + INTERVAL '1 minute';

  WHILE iter < max_iter LOOP
    -- Wall-clock time in the schedule's TZ. We compare each cron field
    -- against this local-time decomposition, NOT UTC.
    cand_local := cand_utc AT TIME ZONE tz;

    cur_min  := EXTRACT(MINUTE FROM cand_local)::INT;
    cur_hour := EXTRACT(HOUR   FROM cand_local)::INT;
    cur_dom  := EXTRACT(DAY    FROM cand_local)::INT;
    cur_mon  := EXTRACT(MONTH  FROM cand_local)::INT;
    cur_dow  := EXTRACT(DOW    FROM cand_local)::INT;  -- 0=Sun..6=Sat

    -- Cron's "7" is also Sunday. Normalize the field so 7 matches dow=0.
    -- We do this by transforming the field text rather than the value, so
    -- "0,7" still works and "1-7" expands sensibly.
    IF public.autopost_cron_field_match(f_min,  cur_min,  0,  59)
       AND public.autopost_cron_field_match(f_hour, cur_hour, 0,  23)
       AND public.autopost_cron_field_match(f_dom,  cur_dom,  1,  31)
       AND public.autopost_cron_field_match(f_mon,  cur_mon,  1,  12)
       AND (
            public.autopost_cron_field_match(f_dow, cur_dow, 0, 6)
            -- "7" alias for Sunday: only check when the field text contains a literal 7
            -- (delimited by start/end-of-string, comma, hyphen, or slash).
            OR (cur_dow = 0 AND f_dow ~ '(^|[,/-])7($|[,/-])')
       )
    THEN
      RETURN cand_utc;
    END IF;

    cand_utc := cand_utc + INTERVAL '1 minute';
    iter := iter + 1;
  END LOOP;

  RAISE EXCEPTION 'autopost_advance_next_fire: no match in 366 days for "%"', cron_expr;
END;
$$;

COMMENT ON FUNCTION public.autopost_advance_next_fire(TEXT, TIMESTAMPTZ, TEXT)
  IS 'Returns the next timestamptz strictly after current_fire that matches the 5-field cron expression, evaluated in the supplied IANA timezone. Raises if no match within 366 days.';


-- ============================================================
-- 3b. Cron parser unit tests (assertion DO blocks)
-- ============================================================
-- Each block computes a known-answer fixture and RAISEs EXCEPTION on
-- mismatch. The migration aborts at the first failing assertion -- that
-- is the desired behavior.

DO $tests$
DECLARE
  got TIMESTAMPTZ;
  expected TIMESTAMPTZ;
BEGIN
  -- Fixture 1: "0 9 * * 1,3,5" (M/W/F 9am ET) starting from a Monday at 09:00:00 ET.
  -- Monday 2024-03-04 09:00:00-05:00 -> next fire is Wednesday 2024-03-06 09:00:00-05:00.
  got := public.autopost_advance_next_fire(
    '0 9 * * 1,3,5',
    '2024-03-04 14:00:00+00'::TIMESTAMPTZ,        -- = Mon 09:00 ET
    'America/New_York'
  );
  expected := '2024-03-06 14:00:00+00'::TIMESTAMPTZ;  -- Wed 09:00 ET
  IF got <> expected THEN
    RAISE EXCEPTION 'cron test 1 (M/W/F 9am) failed: got %, expected %', got, expected;
  END IF;

  -- Fixture 2: "*/15 * * * *" -- every 15 minutes.
  -- From 12:00:00 UTC the next match is 12:15:00 UTC.
  got := public.autopost_advance_next_fire(
    '*/15 * * * *',
    '2024-06-01 12:00:00+00'::TIMESTAMPTZ,
    'UTC'
  );
  expected := '2024-06-01 12:15:00+00'::TIMESTAMPTZ;
  IF got <> expected THEN
    RAISE EXCEPTION 'cron test 2 (*/15) failed: got %, expected %', got, expected;
  END IF;

  -- Fixture 3: "0 0 * * 0" -- Sunday midnight (dow=0).
  -- From Saturday 2024-06-01 12:00 UTC the next Sunday-midnight in UTC is
  -- 2024-06-02 00:00:00+00.
  got := public.autopost_advance_next_fire(
    '0 0 * * 0',
    '2024-06-01 12:00:00+00'::TIMESTAMPTZ,
    'UTC'
  );
  expected := '2024-06-02 00:00:00+00'::TIMESTAMPTZ;
  IF got <> expected THEN
    RAISE EXCEPTION 'cron test 3 (Sun midnight) failed: got %, expected %', got, expected;
  END IF;

  -- Fixture 4: DST spring-forward in America/New_York on 2024-03-10.
  -- "*/15 * * * *" advancing from 06:45 UTC (= 01:45 EST). The next 15-minute
  -- mark in local time would be 02:00 EST, but at 02:00 the clock jumps to
  -- 03:00 EDT -- so the next *real* minute that rounds to a /15 in local time
  -- is 03:00 EDT = 07:00:00 UTC. Our iterator is in UTC space, so it just
  -- advances to 07:00 UTC and asks "is :00 a multiple of 15?" -- yes.
  got := public.autopost_advance_next_fire(
    '*/15 * * * *',
    '2024-03-10 06:45:00+00'::TIMESTAMPTZ,
    'America/New_York'
  );
  expected := '2024-03-10 07:00:00+00'::TIMESTAMPTZ;
  IF got <> expected THEN
    RAISE EXCEPTION 'cron test 4 (DST spring fwd */15) failed: got %, expected %', got, expected;
  END IF;

  -- Fixture 5: same DST day, but a daily 02:30 ET schedule. 02:30 ET does
  -- not exist on 2024-03-10 (skipped by spring forward). The next valid
  -- 02:30 local-time is the FOLLOWING day, 2024-03-11 02:30 EDT = 06:30 UTC.
  got := public.autopost_advance_next_fire(
    '30 2 * * *',
    '2024-03-10 06:00:00+00'::TIMESTAMPTZ,        -- = 01:00 EST
    'America/New_York'
  );
  expected := '2024-03-11 06:30:00+00'::TIMESTAMPTZ;  -- 02:30 EDT next day
  IF got <> expected THEN
    RAISE EXCEPTION 'cron test 5 (DST skipped 02:30) failed: got %, expected %', got, expected;
  END IF;

  RAISE NOTICE 'autopost cron parser unit tests: all 5 fixtures passed';
END;
$tests$;


-- ============================================================
-- 4. autopost_tick
-- ============================================================
-- Per-minute driver. SECURITY DEFINER so it can write to autopost_* tables
-- and video_generation_jobs without RLS friction; pg_cron invokes it as
-- the cron user. Quietly returns when:
--   * autopost_enabled flag is false
--   * no schedules are due
-- and per-schedule errors are caught so one bad row cannot kill the tick.

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
    -- Wrap each schedule in its own subtransaction so one bad cron string
    -- or missing target account cannot abort the whole tick.
    BEGIN
      -- Compute the next fire and update the schedule row up front so
      -- even if everything below explodes, we don't loop on this row again
      -- on the next tick.
      next_fire := public.autopost_advance_next_fire(
        s.cron_expression, s.next_fire_at, s.timezone
      );

      UPDATE public.autopost_schedules
         SET next_fire_at = next_fire
       WHERE id = s.id;

      -- Pick topic + resolve prompt template.
      topic    := public.autopost_resolve_topic(s);
      resolved := public.autopost_resolve_prompt(
        s.prompt_template, topic, NOW(), s.timezone
      );
      -- {schedule_name} is left for the caller; substitute it here so the
      -- run row stores a fully-resolved prompt.
      IF resolved IS NOT NULL THEN
        resolved := replace(resolved, '{schedule_name}', s.name);
      END IF;

      -- Insert the run row first so we have an id for the video job payload.
      INSERT INTO public.autopost_runs (
        schedule_id, fired_at, topic, prompt_resolved, status
      ) VALUES (
        s.id, NOW(), topic, COALESCE(resolved, ''), 'queued'
      )
      RETURNING id INTO new_run_id;

      -- Enqueue the render. project_id is nullable for autopost.
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

      -- Wire run -> job and flip status.
      UPDATE public.autopost_runs
         SET video_job_id = new_job_id,
             status       = 'generating'
       WHERE id = new_run_id;

    EXCEPTION WHEN OTHERS THEN
      -- If the run insert succeeded before the failure, mark it failed.
      -- If it didn't, there is nothing user-visible to update -- the
      -- schedule's next_fire_at still moved forward (or didn't, if the
      -- failure was in autopost_advance_next_fire), and we just let the
      -- next tick try again.
      IF new_run_id IS NOT NULL THEN
        UPDATE public.autopost_runs
           SET status        = 'failed',
               error_summary = SQLERRM
         WHERE id = new_run_id;
      END IF;
      RAISE NOTICE 'autopost_tick: schedule % failed: %', s.id, SQLERRM;
    END;

    -- Reset locals before the next iteration so the EXCEPTION branch can
    -- distinguish "run was created" from "run was not yet created".
    new_run_id := NULL;
    new_job_id := NULL;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.autopost_tick()
  IS 'Per-minute driver invoked by pg_cron. Quietly returns when autopost_enabled is false or no schedules are due. Per-schedule errors are isolated.';

GRANT EXECUTE ON FUNCTION public.autopost_tick() TO authenticated, service_role;


-- ============================================================
-- 5. Render-completed trigger
-- ============================================================
-- When a video_generation_jobs row tagged task_type='autopost_render'
-- flips to status='completed', mark the run 'rendered', fan out one
-- publish job per target_account_id on the schedule, then mark the run
-- 'publishing'. We only fire on the actual transition so re-saves of an
-- already-completed row are idempotent.

CREATE OR REPLACE FUNCTION public.autopost_on_video_completed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  run_id UUID;
BEGIN
  IF NEW.status = 'completed'
     AND OLD.status IS DISTINCT FROM 'completed'
     AND (NEW.payload->>'autopost_run_id') IS NOT NULL
  THEN
    run_id := (NEW.payload->>'autopost_run_id')::UUID;

    UPDATE public.autopost_runs
       SET status = 'rendered'
     WHERE id = run_id;

    INSERT INTO public.autopost_publish_jobs (
      run_id, social_account_id, platform, status, scheduled_for
    )
    SELECT
      run_id,
      sa.id,
      sa.platform,
      'pending',
      NOW()
      FROM public.autopost_schedules s
      JOIN unnest(s.target_account_ids) AS target_id ON TRUE
      JOIN public.autopost_social_accounts sa ON sa.id = target_id
     WHERE s.id = (
       SELECT schedule_id FROM public.autopost_runs WHERE id = run_id
     );

    UPDATE public.autopost_runs
       SET status = 'publishing'
     WHERE id = run_id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.autopost_on_video_completed()
  IS 'AFTER UPDATE trigger on video_generation_jobs: when an autopost_render job flips to completed, fan out per-target publish_jobs rows and advance the run state.';

DROP TRIGGER IF EXISTS autopost_on_video_completed_trg ON public.video_generation_jobs;
CREATE TRIGGER autopost_on_video_completed_trg
  AFTER UPDATE ON public.video_generation_jobs
  FOR EACH ROW
  WHEN (NEW.task_type = 'autopost_render')
  EXECUTE FUNCTION public.autopost_on_video_completed();


-- ============================================================
-- 6. Register the per-minute tick
-- ============================================================
-- pg_cron is enabled in 20260428120100. Drop any existing job by name
-- before re-registering so the migration is idempotent.

DO $cron_register$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'autopost-tick') THEN
    PERFORM cron.unschedule('autopost-tick');
  END IF;
  PERFORM cron.schedule('autopost-tick', '* * * * *', $cron$select autopost_tick();$cron$);
EXCEPTION WHEN undefined_function OR undefined_table THEN
  RAISE NOTICE 'pg_cron not available, skipping autopost-tick registration';
END;
$cron_register$;
