-- Drop stale/duplicate storage policies for audio and scene-videos buckets and
-- recreate them in their correct final form.  Handles any starting DB state: the
-- original schema-defined policies (wrong names or missing role/folder qualifiers),
-- policies left by earlier fix migrations, or a mix of both.

-- audio: ensure INSERT and SELECT carry the TO authenticated role binding
DROP POLICY IF EXISTS "Users can upload their own audio" ON storage.objects;
DROP POLICY IF EXISTS "Users can view their own audio"   ON storage.objects;

CREATE POLICY "Users can upload their own audio"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can view their own audio"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);

-- scene-videos: enforce per-user folder restriction and add service_role catch-all.
-- Drop all known name variants (original schema names + names from prior fix migration).
DROP POLICY IF EXISTS "Users can upload to scene-videos"              ON storage.objects;
DROP POLICY IF EXISTS "Users can update scene-videos"                 ON storage.objects;
DROP POLICY IF EXISTS "Users can delete from scene-videos"            ON storage.objects;
DROP POLICY IF EXISTS "Users can upload to own scene-videos folder"   ON storage.objects;
DROP POLICY IF EXISTS "Users can update own scene-videos files"       ON storage.objects;
DROP POLICY IF EXISTS "Users can delete from own scene-videos folder" ON storage.objects;
DROP POLICY IF EXISTS "Service role can manage all scene-videos"      ON storage.objects;

CREATE POLICY "Users can upload to own scene-videos folder"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'scene-videos' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can update own scene-videos files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'scene-videos' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete from own scene-videos folder"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'scene-videos' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Service role can manage all scene-videos"
  ON storage.objects FOR ALL TO service_role
  USING     (bucket_id = 'scene-videos')
  WITH CHECK (bucket_id = 'scene-videos');
