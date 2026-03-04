-- Make the audio bucket private
UPDATE storage.buckets SET public = false WHERE id = 'audio';

-- Remove the overly permissive public access policy
DROP POLICY IF EXISTS "Audio files are publicly accessible" ON storage.objects;

-- Keep the owner-only policies which are already correct:
-- "Users can upload their own audio" - INSERT
-- "Users can view their own audio" - SELECT (owner only)

-- Add policy for service role to manage all audio files (for edge functions)
CREATE POLICY "Service role can manage all audio"
ON storage.objects
FOR ALL
TO service_role
USING (bucket_id = 'audio')
WITH CHECK (bucket_id = 'audio');

-- Add policy for users to update/delete their own audio
CREATE POLICY "Users can update their own audio"
ON storage.objects
FOR UPDATE
TO authenticated
USING (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete their own audio"
ON storage.objects
FOR DELETE
TO authenticated
USING (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);