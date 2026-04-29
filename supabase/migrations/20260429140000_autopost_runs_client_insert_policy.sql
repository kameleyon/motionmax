-- ============================================================
-- Allow admins to insert a queued run for their own schedule.
--
-- Background: Run-now used to POST /api/autopost/schedules/:id/fire,
-- a Vercel Function that authenticated as service-role and inserted
-- the row. That function kept failing with FUNCTION_INVOCATION_FAILED
-- on the platform layer, and adding a serverless hop for a
-- two-query operation didn't match the project's "trivial ops via
-- supabase-js, heavy ops via Render worker" scaling philosophy.
--
-- This policy lets the browser perform the insert directly with the
-- caller's JWT. Equivalent admin + ownership gate as the old
-- requireAdmin() + select-then-check pattern, enforced at the DB.
--
-- Worker behavior is unchanged: it polls autopost_runs.status='queued'
-- regardless of insertion source.
-- ============================================================

DROP POLICY IF EXISTS "admins insert runs for own schedules" ON public.autopost_runs;
CREATE POLICY "admins insert runs for own schedules"
  ON public.autopost_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_admin(auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.autopost_schedules s
       WHERE s.id = autopost_runs.schedule_id
         AND s.user_id = auth.uid()
    )
  );
