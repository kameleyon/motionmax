-- Migration: autopost_platform_metrics
--
-- Wave 4 (production hardening) of the Autopost feature build, per
-- AUTOPOST_PLAN.md §12 and AUTOPOST_ROADMAP.md Phase 12.
--
-- Daily-bucketed per-platform success/failure counters. The dispatcher
-- upserts into this table after every terminal publish_job state change
-- so we have a cheap aggregate to drive the daily summary report and
-- any future admin metrics dashboard.
--
-- We intentionally do NOT pull these counts from autopost_publish_jobs
-- on read: that table can grow unbounded, and an aggregate over a
-- multi-month window of jobs would scan rows we no longer need to see.
-- A daily roll-up gives us O(days * platforms * users) row growth, which
-- is bounded for any practical user count.

CREATE TABLE IF NOT EXISTS public.autopost_platform_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform        TEXT NOT NULL CHECK (platform IN ('youtube', 'instagram', 'tiktok')),
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket          DATE NOT NULL,                  -- daily roll-up key (UTC date)
  succeeded       INT NOT NULL DEFAULT 0,
  failed          INT NOT NULL DEFAULT 0,
  retried         INT NOT NULL DEFAULT 0,
  total_attempts  INT NOT NULL DEFAULT 0,
  UNIQUE (platform, user_id, bucket)
);

ALTER TABLE public.autopost_platform_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin reads own metrics" ON public.autopost_platform_metrics;
CREATE POLICY "admin reads own metrics"
  ON public.autopost_platform_metrics
  FOR SELECT
  USING (auth.uid() = user_id AND public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "service role manages metrics" ON public.autopost_platform_metrics;
CREATE POLICY "service role manages metrics"
  ON public.autopost_platform_metrics
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_autopost_metrics_bucket
  ON public.autopost_platform_metrics(bucket DESC);
