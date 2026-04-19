-- Fix: audio bucket INSERT and SELECT policies are missing TO authenticated role binding
-- Drop the original policies (defined without TO authenticated) and recreate them properly.

DROP POLICY IF EXISTS "Users can upload their own audio" ON storage.objects;
DROP POLICY IF EXISTS "Users can view their own audio"   ON storage.objects;

CREATE POLICY "Users can upload their own audio"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can view their own audio"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);
