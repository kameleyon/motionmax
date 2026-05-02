-- Open autopost to every paying plan (Creator+), not just admins.
--
-- Original wave-A migration set the autopost RLS policies to admin-only
-- (e.g. "admins manage own schedules", "admins read runs of own
-- schedules", etc.). That was correct while autopost was an internal
-- alpha. Now that automation is GA for paying plans, the admin gate
-- locks every Creator/Studio/Enterprise user out of their own data.
--
-- Strategy:
--   • Drop the admin gate from every "manage / read / delete / insert
--     own X" policy across autopost_schedules, autopost_runs,
--     autopost_publish_jobs, autopost_platform_metrics, and
--     autopost_social_accounts.
--   • Replace each one with the same ownership check minus is_admin.
--   • For autopost_schedules INSERT, keep is_creator_or_studio so free
--     users still can't insert at the DB layer (the dialog upsell in
--     IntakeForm is the user-facing gate; this is the safety net).
--   • autopost_fire_now: drop the is_admin check at the top; keep the
--     ownership + plan-gate checks.

-- ── 1. autopost_schedules ────────────────────────────────────────────

DROP POLICY IF EXISTS "admins manage own schedules" ON public.autopost_schedules;
DROP POLICY IF EXISTS "creator+ inserts own schedules" ON public.autopost_schedules;

CREATE POLICY "users manage own schedules"
  ON public.autopost_schedules
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "creator+ inserts own schedules"
  ON public.autopost_schedules
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND public.is_creator_or_studio(auth.uid())
  );

-- ── 2. autopost_runs ─────────────────────────────────────────────────

DROP POLICY IF EXISTS "admins read runs of own schedules" ON public.autopost_runs;
DROP POLICY IF EXISTS "admins insert runs for own schedules" ON public.autopost_runs;
DROP POLICY IF EXISTS "admins delete runs of own schedules" ON public.autopost_runs;

CREATE POLICY "users read runs of own schedules"
  ON public.autopost_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.autopost_schedules s
       WHERE s.id = autopost_runs.schedule_id
         AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "users insert runs for own schedules"
  ON public.autopost_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.autopost_schedules s
       WHERE s.id = autopost_runs.schedule_id
         AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "users delete runs of own schedules"
  ON public.autopost_runs
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.autopost_schedules s
       WHERE s.id = autopost_runs.schedule_id
         AND s.user_id = auth.uid()
    )
  );

-- ── 3. autopost_publish_jobs ─────────────────────────────────────────

DROP POLICY IF EXISTS "admins read publish jobs of own runs" ON public.autopost_publish_jobs;

CREATE POLICY "users read publish jobs of own runs"
  ON public.autopost_publish_jobs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.autopost_runs r
        JOIN public.autopost_schedules s ON s.id = r.schedule_id
       WHERE r.id = autopost_publish_jobs.run_id
         AND s.user_id = auth.uid()
    )
  );

-- ── 4. autopost_platform_metrics ─────────────────────────────────────

DROP POLICY IF EXISTS "admin reads own metrics" ON public.autopost_platform_metrics;

CREATE POLICY "users read own metrics"
  ON public.autopost_platform_metrics
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ── 5. autopost_social_accounts ──────────────────────────────────────

DROP POLICY IF EXISTS "admins manage own social accounts" ON public.autopost_social_accounts;

CREATE POLICY "users manage own social accounts"
  ON public.autopost_social_accounts
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── 6. autopost_fire_now: drop the is_admin gate ─────────────────────
-- Manual /fire button (run-now) used to require admin; now any owner of
-- the schedule on a paying plan can fire it. Ownership + plan-eligibility
-- + topic-pool guards remain.

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
