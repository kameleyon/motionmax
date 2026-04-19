-- Fix scene-videos bucket: restrict writes to user's own folder (auth.uid() prefix).

DROP POLICY IF EXISTS "Users can upload to scene-videos"   ON storage.objects;
DROP POLICY IF EXISTS "Users can update scene-videos"      ON storage.objects;
DROP POLICY IF EXISTS "Users can delete from scene-videos" ON storage.objects;

CREATE POLICY "Users can upload to own scene-videos folder"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'scene-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Users can update own scene-videos files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'scene-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Users can delete from own scene-videos folder"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'scene-videos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Service role can manage all scene-videos"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'scene-videos')
  WITH CHECK (bucket_id = 'scene-videos');
