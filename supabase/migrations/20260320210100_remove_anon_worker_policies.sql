-- ============================================================
-- Migration: Remove anon USING(true) policies on video_generation_jobs
-- The worker MUST use service_role key which bypasses RLS entirely.
-- Keeping anon USING(true) is an unnecessary security surface.
-- ============================================================

-- Drop the overly permissive anon policies (created in 20260310000001)
DROP POLICY IF EXISTS "anon_worker_select_jobs" ON video_generation_jobs;
DROP POLICY IF EXISTS "anon_worker_update_jobs" ON video_generation_jobs;

-- Authenticated user policies are untouched:
--   "authenticated_select_own_jobs" → user_id = auth.uid()
--   "authenticated_insert_own_jobs" → user_id = auth.uid()
-- Service role bypasses RLS entirely, no policy needed.
