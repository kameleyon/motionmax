-- Allow authenticated users to upload to scene-videos bucket (path: userId/... or generationId/...)
CREATE POLICY "Users can upload to scene-videos"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'scene-videos');

-- Allow authenticated users to update/overwrite in scene-videos
CREATE POLICY "Users can update scene-videos"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'scene-videos');

-- Allow authenticated users to delete from scene-videos
CREATE POLICY "Users can delete from scene-videos"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'scene-videos');