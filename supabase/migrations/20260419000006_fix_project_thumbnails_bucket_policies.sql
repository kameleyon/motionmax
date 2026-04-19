-- Fix project-thumbnails bucket: restrict write/delete to service_role only.
-- The original policies had no TO clause, making them open to all roles.

DROP POLICY IF EXISTS "Service role can upload project thumbnails" ON storage.objects;
DROP POLICY IF EXISTS "Service role can delete project thumbnails" ON storage.objects;

CREATE POLICY "Service role can upload project thumbnails"
  ON storage.objects FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'project-thumbnails');

CREATE POLICY "Service role can update project thumbnails"
  ON storage.objects FOR UPDATE TO service_role
  USING (bucket_id = 'project-thumbnails');

CREATE POLICY "Service role can delete project thumbnails"
  ON storage.objects FOR DELETE TO service_role
  USING (bucket_id = 'project-thumbnails');
