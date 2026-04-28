-- Migration: autopost_schema
--
-- Wave 1 of the Autopost feature build (per AUTOPOST_PLAN.md §6 and
-- AUTOPOST_ROADMAP.md Phase 1). Adds:
--
--   * autopost_social_accounts  - one row per (user, platform, account)
--   * autopost_schedules        - recurring generation+publish schedules
--   * autopost_runs             - one row per schedule fire
--   * autopost_publish_jobs     - one row per (run, target account)
--   * app_settings              - global flag table (already exists; we
--                                  CREATE TABLE IF NOT EXISTS to be safe
--                                  and seed autopost-specific keys)
--
-- All four autopost_* tables get RLS enabled with admin-gated policies,
-- because the soft launch is admin-only (per §5 of the plan). When the
-- feature graduates to Studio Pro users we will ALTER POLICY rather than
-- changing this migration.
--
-- Token columns (access_token, refresh_token) are stored as plain TEXT
-- in this migration. pgsodium / Supabase Vault column-level encryption
-- is applied in production via the Vault UI; encoding it in the
-- migration would either break local dev (extension OS-dependent) or
-- require manual Vault key creation. The wave 2 OAuth callback handler
-- is the only writer so we can add encryption transparently later.
-- TODO: pgsodium column-level encryption applied via Supabase Vault in prod
--
-- Re-running the migration is safe: every CREATE uses IF NOT EXISTS
-- and the seed insert uses ON CONFLICT (key) DO NOTHING.

-- ============================================================
-- 6.1 Connected social accounts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.autopost_social_accounts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform             TEXT NOT NULL CHECK (platform IN ('youtube', 'instagram', 'tiktok')),
  platform_account_id  TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  avatar_url           TEXT,
  -- TODO: pgsodium column-level encryption applied via Supabase Vault in prod
  access_token         TEXT NOT NULL,
  -- TODO: pgsodium column-level encryption applied via Supabase Vault in prod
  refresh_token        TEXT,
  token_expires_at     TIMESTAMPTZ,
  scopes               TEXT[] NOT NULL,
  status               TEXT NOT NULL DEFAULT 'connected'
                         CHECK (status IN ('connected', 'expired', 'revoked', 'error')),
  last_error           TEXT,
  provider_metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  connected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, platform, platform_account_id)
);

COMMENT ON COLUMN public.autopost_social_accounts.access_token
  IS 'OAuth access token. Plaintext in dev; Supabase Vault column encryption applied in prod.';
COMMENT ON COLUMN public.autopost_social_accounts.refresh_token
  IS 'OAuth refresh token. Plaintext in dev; Supabase Vault column encryption applied in prod.';
COMMENT ON COLUMN public.autopost_social_accounts.provider_metadata
  IS 'Free-form per-platform metadata (channel handle, IG business account fields, TikTok open_id, etc.). Reserved for forward flexibility without migrations.';

-- ============================================================
-- 6.2 Recurring schedules
-- ============================================================
CREATE TABLE IF NOT EXISTS public.autopost_schedules (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  active               BOOLEAN NOT NULL DEFAULT TRUE,

  -- generation
  prompt_template      TEXT NOT NULL,
  topic_pool           TEXT[],
  motion_preset        TEXT,
  duration_seconds     INT NOT NULL DEFAULT 30,
  resolution           TEXT NOT NULL DEFAULT '1080x1920',

  -- schedule
  cron_expression      TEXT NOT NULL,
  timezone             TEXT NOT NULL DEFAULT 'America/New_York',
  next_fire_at         TIMESTAMPTZ NOT NULL,

  -- targets
  target_account_ids   UUID[] NOT NULL,
  caption_template     TEXT,
  hashtags             TEXT[],
  ai_disclosure        BOOLEAN NOT NULL DEFAULT TRUE,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 6.3 Runs (one per schedule fire)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.autopost_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id          UUID NOT NULL REFERENCES public.autopost_schedules(id) ON DELETE CASCADE,
  fired_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  topic                TEXT,
  prompt_resolved      TEXT NOT NULL,
  video_job_id         UUID REFERENCES public.video_generation_jobs(id),
  status               TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN
                           ('queued', 'generating', 'rendered',
                            'publishing', 'completed', 'failed', 'cancelled')),
  error_summary        TEXT
);

-- ============================================================
-- 6.3b Publish jobs (one per run x target account)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.autopost_publish_jobs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               UUID NOT NULL REFERENCES public.autopost_runs(id) ON DELETE CASCADE,
  social_account_id    UUID NOT NULL REFERENCES public.autopost_social_accounts(id) ON DELETE CASCADE,
  platform             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN
                           ('pending', 'uploading', 'processing',
                            'published', 'failed', 'rejected')),
  attempts             INT NOT NULL DEFAULT 0,
  last_attempt_at      TIMESTAMPTZ,
  scheduled_for        TIMESTAMPTZ,
  platform_post_id     TEXT,
  platform_post_url    TEXT,
  error_code           TEXT,
  error_message        TEXT,
  caption              TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_autopost_schedules_next_fire
  ON public.autopost_schedules (next_fire_at)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_autopost_publish_jobs_status_sched
  ON public.autopost_publish_jobs (status, scheduled_for)
  WHERE status IN ('pending', 'uploading');

CREATE INDEX IF NOT EXISTS idx_autopost_runs_schedule_fired
  ON public.autopost_runs (schedule_id, fired_at DESC);

-- ============================================================
-- 6.4 app_settings table (idempotent — already exists; seed keys)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.app_settings (key, value, updated_at) VALUES
  ('autopost_enabled',            'false'::jsonb,     NOW()),
  ('autopost_youtube_enabled',    'true'::jsonb,      NOW()),
  ('autopost_instagram_enabled',  'true'::jsonb,      NOW()),
  ('autopost_tiktok_enabled',     'true'::jsonb,      NOW()),
  ('autopost_tiktok_audit_status', '"pending"'::jsonb, NOW())
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 6.5 RLS - admin-gated soft launch policies
-- ============================================================
ALTER TABLE public.autopost_social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autopost_schedules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autopost_runs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autopost_publish_jobs    ENABLE ROW LEVEL SECURITY;

-- Drop-then-create so the migration is idempotent.

-- ---- autopost_social_accounts ----
DROP POLICY IF EXISTS "admins manage own social accounts" ON public.autopost_social_accounts;
CREATE POLICY "admins manage own social accounts"
  ON public.autopost_social_accounts
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id AND public.is_admin(auth.uid()))
  WITH CHECK (auth.uid() = user_id AND public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "service role manages social accounts" ON public.autopost_social_accounts;
CREATE POLICY "service role manages social accounts"
  ON public.autopost_social_accounts
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---- autopost_schedules ----
DROP POLICY IF EXISTS "admins manage own schedules" ON public.autopost_schedules;
CREATE POLICY "admins manage own schedules"
  ON public.autopost_schedules
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id AND public.is_admin(auth.uid()))
  WITH CHECK (auth.uid() = user_id AND public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "service role manages schedules" ON public.autopost_schedules;
CREATE POLICY "service role manages schedules"
  ON public.autopost_schedules
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---- autopost_runs ----
DROP POLICY IF EXISTS "admins read runs of own schedules" ON public.autopost_runs;
CREATE POLICY "admins read runs of own schedules"
  ON public.autopost_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.autopost_schedules s
       WHERE s.id = autopost_runs.schedule_id
         AND s.user_id = auth.uid()
         AND public.is_admin(auth.uid())
    )
  );

DROP POLICY IF EXISTS "service role inserts/updates runs" ON public.autopost_runs;
CREATE POLICY "service role inserts/updates runs"
  ON public.autopost_runs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---- autopost_publish_jobs ----
DROP POLICY IF EXISTS "admins read publish jobs of own runs" ON public.autopost_publish_jobs;
CREATE POLICY "admins read publish jobs of own runs"
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
         AND public.is_admin(auth.uid())
    )
  );

DROP POLICY IF EXISTS "service role manages publish jobs" ON public.autopost_publish_jobs;
CREATE POLICY "service role manages publish jobs"
  ON public.autopost_publish_jobs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- ---- app_settings: admin read (service_role write policy already
--      exists from 20260427100300; we only add the admin SELECT policy
--      so the lab UI can read flags directly without RPC roundtrips).
DROP POLICY IF EXISTS "admins read app_settings" ON public.app_settings;
CREATE POLICY "admins read app_settings"
  ON public.app_settings
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- ============================================================
-- updated_at maintenance triggers
-- ============================================================
CREATE OR REPLACE FUNCTION public.autopost_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autopost_schedules_touch ON public.autopost_schedules;
CREATE TRIGGER trg_autopost_schedules_touch
  BEFORE UPDATE ON public.autopost_schedules
  FOR EACH ROW EXECUTE FUNCTION public.autopost_touch_updated_at();

DROP TRIGGER IF EXISTS trg_autopost_publish_jobs_touch ON public.autopost_publish_jobs;
CREATE TRIGGER trg_autopost_publish_jobs_touch
  BEFORE UPDATE ON public.autopost_publish_jobs
  FOR EACH ROW EXECUTE FUNCTION public.autopost_touch_updated_at();
