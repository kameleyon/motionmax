-- Ensure the 'audio' storage bucket exists.
-- The edge function and the Render worker both use this bucket for TTS audio files.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'audio',
  'audio',
  false,
  104857600,
  ARRAY['audio/mpeg', 'audio/wav', 'audio/ogg', 'image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Authenticated users can read audio
DROP POLICY IF EXISTS "authenticated_read_audio" ON storage.objects;
CREATE POLICY "authenticated_read_audio" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'audio');

-- Authenticated users can upload audio (edge functions acting on behalf of user)
DROP POLICY IF EXISTS "authenticated_upload_audio" ON storage.objects;
CREATE POLICY "authenticated_upload_audio" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'audio');

-- Anon key can read (worker fallback key)
DROP POLICY IF EXISTS "anon_read_audio" ON storage.objects;
CREATE POLICY "anon_read_audio" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'audio');

-- Anon key can upload (worker fallback key)
DROP POLICY IF EXISTS "anon_upload_audio" ON storage.objects;
CREATE POLICY "anon_upload_audio" ON storage.objects
  FOR INSERT TO anon
  WITH CHECK (bucket_id = 'audio');

-- Anon key can update (for upsert)
DROP POLICY IF EXISTS "anon_update_audio" ON storage.objects;
CREATE POLICY "anon_update_audio" ON storage.objects
  FOR UPDATE TO anon
  USING (bucket_id = 'audio');

-- Ensure the 'scene-images' bucket exists (used by Hypereal image upload path).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'scene-images',
  'scene-images',
  false,
  104857600,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "authenticated_read_scene_images" ON storage.objects;
CREATE POLICY "authenticated_read_scene_images" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'scene-images');

DROP POLICY IF EXISTS "authenticated_upload_scene_images" ON storage.objects;
CREATE POLICY "authenticated_upload_scene_images" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'scene-images');

DROP POLICY IF EXISTS "anon_read_scene_images" ON storage.objects;
CREATE POLICY "anon_read_scene_images" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'scene-images');

DROP POLICY IF EXISTS "anon_upload_scene_images" ON storage.objects;
CREATE POLICY "anon_upload_scene_images" ON storage.objects
  FOR INSERT TO anon
  WITH CHECK (bucket_id = 'scene-images');
