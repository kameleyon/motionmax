-- Fix: scene-images bucket was created with public=false in migration
-- 20260315195000_create_audio_bucket.sql (line 48), but the intended
-- design (001_full_schema.sql) sets it public=true.
--
-- Impact: worker downloads scene images via /object/public/ URL which
-- returns 400 Bad Request for private buckets → all 15 scenes fail export.
--
-- scene-images stores AI-generated content under UUID paths.
-- Paths are not guessable; public access is intentional and required
-- for the export worker to download images without auth tokens.

UPDATE storage.buckets
SET public = true
WHERE id = 'scene-images';

-- Also ensure the anon read policy exists (may have been dropped by
-- a later security migration).
DROP POLICY IF EXISTS "anon_read_scene_images" ON storage.objects;
CREATE POLICY "anon_read_scene_images" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'scene-images');
