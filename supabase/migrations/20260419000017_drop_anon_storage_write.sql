-- Remove anonymous write access to the videos bucket.
-- The Render worker must authenticate with the service_role key instead of the anon key.
-- This prevents any unauthenticated client from uploading files to storage.

DROP POLICY IF EXISTS "anon_worker_upload_videos" ON storage.objects;

-- Only the service_role (used by trusted backend workers) may insert into the videos bucket.
CREATE POLICY "service_role_upload_videos" ON storage.objects
  FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'videos');
