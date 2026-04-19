-- ============================================================
-- Unify video_generation_jobs RLS policies
--
-- Five prior migrations created, dropped, and re-created policies
-- under varying names, leaving the policy set non-idempotent on
-- a fresh DB replay. This migration:
--   1. Drops every policy name that ever appeared on this table.
--   2. Creates exactly the three desired policies, idempotently.
--
-- Desired final state:
--   authenticated  SELECT  user_id = auth.uid()
--   authenticated  INSERT  user_id = auth.uid()
--   service_role   ALL     bypass (worker uses service_role key)
-- ============================================================

-- Step 1: purge every historical policy name
DROP POLICY IF EXISTS "worker_read_jobs"                ON public.video_generation_jobs;
DROP POLICY IF EXISTS "worker_insert_jobs"              ON public.video_generation_jobs;
DROP POLICY IF EXISTS "worker_update_jobs"              ON public.video_generation_jobs;
DROP POLICY IF EXISTS "worker_delete_jobs"              ON public.video_generation_jobs;
DROP POLICY IF EXISTS "anon_worker_select_jobs"         ON public.video_generation_jobs;
DROP POLICY IF EXISTS "anon_worker_update_jobs"         ON public.video_generation_jobs;
DROP POLICY IF EXISTS "authenticated_select_own_jobs"   ON public.video_generation_jobs;
DROP POLICY IF EXISTS "authenticated_insert_own_jobs"   ON public.video_generation_jobs;
DROP POLICY IF EXISTS "service_role_full_access_jobs"   ON public.video_generation_jobs;

-- Step 2: create canonical final policies
-- Users can read only their own jobs
CREATE POLICY "authenticated_select_own_jobs"
  ON public.video_generation_jobs
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Users can only enqueue jobs for themselves
CREATE POLICY "authenticated_insert_own_jobs"
  ON public.video_generation_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Worker operates via service_role key which bypasses RLS, but an
-- explicit policy prevents breakage if FORCE ROW LEVEL SECURITY is
-- ever applied to this role.
CREATE POLICY "service_role_full_access_jobs"
  ON public.video_generation_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
