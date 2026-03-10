-- Fix overly permissive storage policies on the 'videos' bucket.
-- The original policies allowed any authenticated user to update/delete
-- any other user's videos. This migration replaces them with user-scoped ones.

-- Drop the permissive policies
DROP POLICY IF EXISTS "authenticated_upload_videos"  ON storage.objects;
DROP POLICY IF EXISTS "authenticated_update_videos"  ON storage.objects;
DROP POLICY IF EXISTS "authenticated_delete_videos"  ON storage.objects;
DROP POLICY IF EXISTS "anon_upload_videos"           ON storage.objects;
DROP POLICY IF EXISTS "anon_read_videos"             ON storage.objects;
DROP POLICY IF EXISTS "public_read_videos"           ON storage.objects;

-- ── Public read (intentional — videos are shared via public URLs) ────────────
CREATE POLICY "public_read_videos" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'videos');

-- ── Authenticated users: scoped to their own user_id/ path ──────────────────
-- Upload only to own folder (user_id is the first path segment)
CREATE POLICY "authenticated_upload_own_videos" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Update only own files
CREATE POLICY "authenticated_update_own_videos" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Delete only own files
CREATE POLICY "authenticated_delete_own_videos" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── Anon role (Render worker uploads using the anon key) ────────────────────
-- Worker uploads are placed under a 'generated/' prefix by the worker code.
-- We restrict anon inserts to that prefix only.
CREATE POLICY "anon_worker_upload_videos" ON storage.objects
  FOR INSERT TO anon
  WITH CHECK (
    bucket_id = 'videos'
    AND (storage.foldername(name))[1] = 'generated'
  );
