-- ============================================================
-- autopost_runs.progress_pct — coarse 0..100 percent surface for the
-- run dashboard.
--
-- video_generation_jobs already has a `progress` column the worker
-- updates per phase, but the dashboard lists autopost_runs (one row per
-- fire) and joining each row to its render job for a single integer
-- adds a query per render. Storing the percent on the run row directly
-- keeps the list query a single SELECT and lets pg's realtime stream
-- push deltas the client subscribes to anyway.
--
-- The worker handler (handleAutopostRun) updates this column at five
-- coarse waypoints: kicked off (5), script complete (25), audio/visual
-- jobs queued (35), finalize complete (80), export complete (100).
-- The UI shows a determinate bar when value is non-null.
-- ============================================================

ALTER TABLE public.autopost_runs
  ADD COLUMN IF NOT EXISTS progress_pct INT;

COMMENT ON COLUMN public.autopost_runs.progress_pct
  IS 'Coarse 0..100 percent of the autopost render pipeline. Null on rows older than this column or while a fire has not yet been picked up.';

-- ============================================================
-- Allow admins to delete runs of their own schedules from the
-- run-history page. Same admin + ownership gate as the SELECT policy.
-- Cascades drop the child autopost_publish_jobs rows automatically
-- (FK ON DELETE CASCADE in 20260428120000_autopost_schema.sql).
-- ============================================================
DROP POLICY IF EXISTS "admins delete runs of own schedules" ON public.autopost_runs;
CREATE POLICY "admins delete runs of own schedules"
  ON public.autopost_runs
  FOR DELETE
  TO authenticated
  USING (
    public.is_admin(auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.autopost_schedules s
       WHERE s.id = autopost_runs.schedule_id
         AND s.user_id = auth.uid()
    )
  );
