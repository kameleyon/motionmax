-- ============================================================
-- Admin rebuild — Phase 2.4: schema additions to existing tables
-- ============================================================
-- WHAT: Adds columns and indexes the admin tabs depend on:
--   * video_generation_jobs.started_at, finished_at  (Performance tab)
--   * system_logs.fingerprint, resolved_at, resolved_by,
--     sentry_issue_id, worker_id, level (generated)   (Errors / Console tabs)
--   * api_call_logs.worker_id                         (Console worker filter)
--   * profiles.last_active_at, marketing_opt_in,
--     newsletter_unsubscribed_at                       (Newsletter tab)
--
-- WHY:  These columns are referenced by Phase 2.3 MVs and by the
--       admin tab queries spec'd in Phases 10 / 11 / 12 / 15.
--       Each ADD COLUMN uses IF NOT EXISTS so re-running is safe.
--
-- IMPLEMENTS: ADMIN_REBUILD_CHECKLIST.md section 2.4.
-- ============================================================

BEGIN;

-- ── 1. video_generation_jobs: started_at / finished_at ───────
ALTER TABLE public.video_generation_jobs
  ADD COLUMN IF NOT EXISTS started_at  timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;

-- One-time backfill: completed jobs assume created_at as a
-- conservative started_at and updated_at as finished_at. Going
-- forward the worker stamps these directly on claim/terminal.
UPDATE public.video_generation_jobs
   SET started_at  = COALESCE(started_at, created_at),
       finished_at = COALESCE(finished_at, updated_at)
 WHERE status = 'completed'
   AND (started_at IS NULL OR finished_at IS NULL);

CREATE INDEX IF NOT EXISTS video_generation_jobs_started_at_idx
  ON public.video_generation_jobs (started_at)
  WHERE started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS video_generation_jobs_finished_at_idx
  ON public.video_generation_jobs (finished_at DESC)
  WHERE finished_at IS NOT NULL;

-- ── 2. system_logs: fingerprint, resolution, worker, level ───
ALTER TABLE public.system_logs
  ADD COLUMN IF NOT EXISTS fingerprint     text,
  ADD COLUMN IF NOT EXISTS resolved_at     timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by     uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS sentry_issue_id text,
  ADD COLUMN IF NOT EXISTS worker_id       text;

-- Generated `level` column — derived from category. STORED so it
-- is indexable. Adding a generated column requires the column to
-- not already exist, hence the DO block guard.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'system_logs'
      AND column_name = 'level'
  ) THEN
    EXECUTE $ddl$
      ALTER TABLE public.system_logs
        ADD COLUMN level text GENERATED ALWAYS AS (
          CASE category
            WHEN 'system_error'   THEN 'error'
            WHEN 'system_warning' THEN 'warn'
            ELSE 'info'
          END
        ) STORED
    $ddl$;
  END IF;
END;
$$;

-- Indexes per checklist 2.4
CREATE INDEX IF NOT EXISTS system_logs_fingerprint_created_at_idx
  ON public.system_logs (fingerprint, created_at DESC)
  WHERE category = 'system_error';

CREATE INDEX IF NOT EXISTS system_logs_level_created_at_idx
  ON public.system_logs (level, created_at DESC);

CREATE INDEX IF NOT EXISTS system_logs_worker_id_created_at_idx
  ON public.system_logs (worker_id, created_at DESC)
  WHERE worker_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS system_logs_user_id_created_at_idx
  ON public.system_logs (user_id, created_at DESC);

-- ── 3. api_call_logs.worker_id ───────────────────────────────
ALTER TABLE public.api_call_logs
  ADD COLUMN IF NOT EXISTS worker_id text;

CREATE INDEX IF NOT EXISTS api_call_logs_user_id_created_at_idx
  ON public.api_call_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS api_call_logs_cost_desc_idx
  ON public.api_call_logs (cost DESC)
  WHERE cost IS NOT NULL;

CREATE INDEX IF NOT EXISTS api_call_logs_worker_id_created_at_idx
  ON public.api_call_logs (worker_id, created_at DESC)
  WHERE worker_id IS NOT NULL;

-- ── 4. profiles: last_active_at, marketing opt-in flags ──────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_active_at              timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_opt_in            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS newsletter_unsubscribed_at  timestamptz;

CREATE INDEX IF NOT EXISTS profiles_marketing_opt_in_idx
  ON public.profiles (marketing_opt_in)
  WHERE marketing_opt_in = true;

COMMIT;
