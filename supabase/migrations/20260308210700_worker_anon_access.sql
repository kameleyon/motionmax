-- Allow the Render worker to operate using the anon key
-- when service_role key is not available (Lovable-managed projects).
-- This adds permissive RLS policies for the anon role on the jobs table.

-- Ensure RLS is enabled but add permissive policies
ALTER TABLE video_generation_jobs ENABLE ROW LEVEL SECURITY;

-- Allow reading all pending/processing jobs (worker poll)
CREATE POLICY "worker_read_jobs" ON video_generation_jobs
  FOR SELECT USING (true);

-- Allow inserting new jobs (frontend)
CREATE POLICY "worker_insert_jobs" ON video_generation_jobs
  FOR INSERT WITH CHECK (true);

-- Allow updating job status/progress (worker processing)
CREATE POLICY "worker_update_jobs" ON video_generation_jobs
  FOR UPDATE USING (true);

-- Allow deleting completed/failed jobs (cleanup)
CREATE POLICY "worker_delete_jobs" ON video_generation_jobs
  FOR DELETE USING (true);
