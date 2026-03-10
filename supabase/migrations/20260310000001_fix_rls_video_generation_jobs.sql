-- Fix overly permissive RLS on video_generation_jobs.
-- The original migration (20260308210700) used USING (true) for ALL roles,
-- meaning any anon or authenticated user could read/modify any user's jobs.
-- This migration replaces those policies with properly scoped ones.

-- Drop the permissive blanket policies
DROP POLICY IF EXISTS "worker_read_jobs"   ON video_generation_jobs;
DROP POLICY IF EXISTS "worker_insert_jobs" ON video_generation_jobs;
DROP POLICY IF EXISTS "worker_update_jobs" ON video_generation_jobs;
DROP POLICY IF EXISTS "worker_delete_jobs" ON video_generation_jobs;

-- ── Anon role (Render worker uses the anon key) ──────────────────────────────
-- Worker needs to see all pending/processing jobs to poll the queue
CREATE POLICY "anon_worker_select_jobs" ON video_generation_jobs
  FOR SELECT TO anon
  USING (true);

-- Worker needs to update any job's status, progress, and result
CREATE POLICY "anon_worker_update_jobs" ON video_generation_jobs
  FOR UPDATE TO anon
  USING (true);

-- ── Authenticated role (frontend users) ─────────────────────────────────────
-- Users may only read their own jobs
CREATE POLICY "authenticated_select_own_jobs" ON video_generation_jobs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Users may only create jobs assigned to themselves
CREATE POLICY "authenticated_insert_own_jobs" ON video_generation_jobs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Users do not update jobs directly — that is the worker's responsibility
-- (no UPDATE policy for authenticated)

-- Users may not delete jobs — allow only service role cleanup
-- (no DELETE policy for authenticated or anon)
