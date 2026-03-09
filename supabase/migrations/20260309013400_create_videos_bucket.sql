-- Create the 'videos' storage bucket for video exports and generated videos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'videos',
  'videos',
  true,
  524288000,  -- 500MB
  ARRAY['video/mp4', 'video/webm', 'audio/mpeg', 'image/png', 'image/jpeg']
)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload to the videos bucket
CREATE POLICY "authenticated_upload_videos" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'videos');

-- Allow public read access to videos
CREATE POLICY "public_read_videos" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'videos');

-- Allow authenticated users to update their uploads
CREATE POLICY "authenticated_update_videos" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'videos');

-- Allow authenticated users to delete their uploads
CREATE POLICY "authenticated_delete_videos" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'videos');

-- Allow anon key to upload (worker uses anon key)
CREATE POLICY "anon_upload_videos" ON storage.objects
  FOR INSERT TO anon
  WITH CHECK (bucket_id = 'videos');

-- Allow anon key to read
CREATE POLICY "anon_read_videos" ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'videos');
