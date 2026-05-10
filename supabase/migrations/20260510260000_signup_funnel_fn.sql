-- §11 Lens C1/C2 — real signup funnel.
--
-- Replaces the fake-100% rows the admin Analytics tab was rendering by
-- splicing together three sources we already have plus one tiny new
-- sink for client-side funnel events:
--
--   • landing_visit            ← funnel_events  (NEW, populated by GA mirror or worker on first session)
--   • signup_started           ← funnel_events  (NEW, populated client-side from Auth page)
--   • signup_completed         ← auth.users.created_at
--   • first_generation_started ← funnel_events  (NEW, populated by useGenerationPipeline)
--   • first_generation_completed ← video_generation_jobs (status='completed') OR funnel_events
--   • first_paid_conversion    ← subscriptions (active+paid) OR credit_transactions(purchase)
--
-- Why an event table instead of inferring everything from existing
-- domain tables: stages 1, 2, 4 don't have a domain artifact that
-- matches the semantic of the funnel step.
--
--   • `landing_visit` happens BEFORE any auth row exists, so we can't
--     read it from auth.users. The marketing site can POST a one-shot
--     anonymous event via the public mirror RPC.
--   • `signup_started` happens after the user clicks Get Started but
--     before they finish the email/password flow. auth.users only
--     reflects the COMPLETED signup. Without the event we conflate
--     "form opened" with "form submitted".
--   • `first_generation_started` is also distinct from "first
--     video_generation_jobs row inserted" — the IntakeForm fires the
--     event the instant the user clicks Generate, BEFORE the script
--     phase RPC runs (which is the row insert). At today's failure
--     rates that gap matters; a 5 % insert-error rate would hide
--     itself entirely in a job-row-based funnel.
--
-- Stage rows that have zero events (e.g. landing_visit before the
-- marketing site is hooked up) return count=0 and pct_of_top=0; the
-- admin UI renders these as "—" instead of as 100% to make the gap
-- obvious.
--
-- Function security: SECURITY DEFINER because the funnel needs to
-- count auth.users (admin-only schema) and the public.funnel_events
-- table (no per-row RLS gate on aggregates). The is_admin() gate is
-- the access control.

-- ---------------------------------------------------------------------
-- 1.  funnel_events table — minimal, append-only, partitionable later.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.funnel_events (
  id          BIGSERIAL PRIMARY KEY,
  -- Anonymous-ok user id. NULL for landing_visit / signup_started
  -- events that fire before auth. Populated post-signup via a
  -- client-side replay or via the worker when it has the row.
  user_id     UUID NULL REFERENCES auth.users (id) ON DELETE SET NULL,
  -- Anonymous client id (GA-style hash, or sessionStorage-minted UUID)
  -- so we can stitch pre-signup events to a user_id after they sign in
  -- (separate join job, out of scope here — but the column is here so
  -- we don't have to migrate again later).
  client_id   TEXT NULL,
  stage       TEXT NOT NULL,
  -- Free-form JSON for stage-specific extras (utm_source, project_id,
  -- task_type, error_class). Stays sparse so storage is cheap.
  props       JSONB NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.funnel_events IS
  '§11 Lens C1 — append-only funnel checkpoint store. Rows are written '
  'by the worker (server-side parity) AND by the client trackEvent path '
  'via a Supabase RPC mirror. Aggregated by get_signup_funnel(). Never '
  'rewrite history — duplicate events are fine (DISTINCT user_id in the '
  'aggregator).';

CREATE INDEX IF NOT EXISTS idx_funnel_events_stage_created
  ON public.funnel_events (stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_funnel_events_user
  ON public.funnel_events (user_id)
  WHERE user_id IS NOT NULL;

-- Append-only RLS: authenticated users may write events for themselves
-- (or anonymously, with NULL user_id). Reads gated to admin via the
-- aggregator function below (no policy needed for the table; admin
-- reads pass through SECURITY DEFINER).
ALTER TABLE public.funnel_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS funnel_events_insert_self ON public.funnel_events;
CREATE POLICY funnel_events_insert_self
  ON public.funnel_events
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (
    user_id IS NULL                       -- anonymous landing/signup
    OR user_id = auth.uid()               -- authenticated own writes
  );

-- Public RPC mirror used by the client trackEvent path. Keeps the
-- table free of any SELECT/UPDATE/DELETE policies (admin aggregator
-- bypasses RLS via SECURITY DEFINER) — only INSERTs are exposed.
CREATE OR REPLACE FUNCTION public.record_funnel_event(
  p_stage     TEXT,
  p_client_id TEXT DEFAULT NULL,
  p_props     JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_stage IS NULL OR length(trim(p_stage)) = 0 THEN
    RAISE EXCEPTION 'record_funnel_event: stage required';
  END IF;
  INSERT INTO public.funnel_events (user_id, client_id, stage, props)
  VALUES (auth.uid(), p_client_id, p_stage, p_props);
END;
$$;

REVOKE ALL    ON FUNCTION public.record_funnel_event(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.record_funnel_event(TEXT, TEXT, JSONB) TO authenticated, anon;

-- ---------------------------------------------------------------------
-- 2.  get_signup_funnel — the real aggregator the admin UI calls.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_signup_funnel(
  p_window_days INT DEFAULT 30
)
RETURNS TABLE (
  stage       TEXT,
  count       BIGINT,
  pct_of_top  NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_since         TIMESTAMPTZ;
  v_landing       BIGINT;
  v_signup_start  BIGINT;
  v_signup_done   BIGINT;
  v_first_gen_s   BIGINT;
  v_first_gen_c   BIGINT;
  v_first_paid    BIGINT;
  v_top           BIGINT;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'get_signup_funnel: forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_window_days IS NULL OR p_window_days <= 0 THEN
    p_window_days := 30;
  END IF;
  v_since := NOW() - make_interval(days => p_window_days);

  -- 1) landing_visit (event-sourced; 0 when marketing site hasn't been
  --    wired up yet → UI renders this as "—" rather than as 100%).
  SELECT COUNT(DISTINCT COALESCE(client_id, user_id::text))
    INTO v_landing
    FROM public.funnel_events
   WHERE stage = 'landing_visit'
     AND created_at >= v_since;

  -- 2) signup_started — distinct anon client_ids that fired the event.
  SELECT COUNT(DISTINCT COALESCE(client_id, user_id::text))
    INTO v_signup_start
    FROM public.funnel_events
   WHERE stage = 'signup_started'
     AND created_at >= v_since;

  -- 3) signup_completed — authoritative source is auth.users.
  SELECT COUNT(*)
    INTO v_signup_done
    FROM auth.users
   WHERE created_at >= v_since;

  -- 4) first_generation_started — at least one event for each user
  --    cohorted into the window.
  SELECT COUNT(DISTINCT fe.user_id)
    INTO v_first_gen_s
    FROM public.funnel_events fe
    JOIN auth.users u ON u.id = fe.user_id
   WHERE fe.stage = 'first_generation_started'
     AND u.created_at >= v_since;

  -- 5) first_generation_completed — authoritative source is the
  --    completed jobs table. Filter to the signup-cohort window.
  SELECT COUNT(DISTINCT j.user_id)
    INTO v_first_gen_c
    FROM public.video_generation_jobs j
    JOIN auth.users u ON u.id = j.user_id
   WHERE j.status = 'completed'
     AND u.created_at >= v_since;

  -- 6) first_paid_conversion — non-free active subscriptions for
  --    users in the cohort.
  SELECT COUNT(DISTINCT s.user_id)
    INTO v_first_paid
    FROM public.subscriptions s
    JOIN auth.users u ON u.id = s.user_id
   WHERE u.created_at >= v_since
     AND s.status IN ('active','trialing')
     AND COALESCE(s.plan_name, '') !~* 'free';

  -- Top-of-funnel for the percentage column. Prefer the first stage
  -- with non-zero data so we don't render "0% conversion" everywhere
  -- when landing_visit isn't wired up.
  v_top := GREATEST(
    COALESCE(v_landing, 0),
    COALESCE(v_signup_start, 0),
    COALESCE(v_signup_done, 0),
    1
  );

  RETURN QUERY
  SELECT 'landing_visit'::TEXT,
         COALESCE(v_landing, 0)::BIGINT,
         CASE WHEN v_top = 0 THEN 0::NUMERIC
              ELSE ROUND((COALESCE(v_landing, 0)::NUMERIC / v_top) * 100, 1) END
  UNION ALL
  SELECT 'signup_started'::TEXT,
         COALESCE(v_signup_start, 0)::BIGINT,
         CASE WHEN v_top = 0 THEN 0::NUMERIC
              ELSE ROUND((COALESCE(v_signup_start, 0)::NUMERIC / v_top) * 100, 1) END
  UNION ALL
  SELECT 'signup_completed'::TEXT,
         COALESCE(v_signup_done, 0)::BIGINT,
         CASE WHEN v_top = 0 THEN 0::NUMERIC
              ELSE ROUND((COALESCE(v_signup_done, 0)::NUMERIC / v_top) * 100, 1) END
  UNION ALL
  SELECT 'first_generation_started'::TEXT,
         COALESCE(v_first_gen_s, 0)::BIGINT,
         CASE WHEN v_top = 0 THEN 0::NUMERIC
              ELSE ROUND((COALESCE(v_first_gen_s, 0)::NUMERIC / v_top) * 100, 1) END
  UNION ALL
  SELECT 'first_generation_completed'::TEXT,
         COALESCE(v_first_gen_c, 0)::BIGINT,
         CASE WHEN v_top = 0 THEN 0::NUMERIC
              ELSE ROUND((COALESCE(v_first_gen_c, 0)::NUMERIC / v_top) * 100, 1) END
  UNION ALL
  SELECT 'first_paid_conversion'::TEXT,
         COALESCE(v_first_paid, 0)::BIGINT,
         CASE WHEN v_top = 0 THEN 0::NUMERIC
              ELSE ROUND((COALESCE(v_first_paid, 0)::NUMERIC / v_top) * 100, 1) END;
END;
$$;

REVOKE ALL    ON FUNCTION public.get_signup_funnel(INT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_signup_funnel(INT) TO authenticated;

COMMENT ON FUNCTION public.get_signup_funnel(INT) IS
  '§11 Lens C1 — real signup funnel (six stages). Replaces '
  'admin_analytics_funnel which fudged the first three rows at 100%. '
  'Stages with no events return count=0; UI renders these as "—".';
