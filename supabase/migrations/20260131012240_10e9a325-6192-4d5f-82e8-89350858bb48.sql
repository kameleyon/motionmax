-- 1. Add explicit restrictive policies for user_credits to prevent authenticated users from modifying data
-- Only service role can insert/update/delete credits

CREATE POLICY "Authenticated users cannot insert credits"
ON public.user_credits
AS RESTRICTIVE
FOR INSERT
TO authenticated
WITH CHECK (false);

CREATE POLICY "Authenticated users cannot update credits"
ON public.user_credits
AS RESTRICTIVE
FOR UPDATE
TO authenticated
USING (false)
WITH CHECK (false);

CREATE POLICY "Authenticated users cannot delete credits"
ON public.user_credits
AS RESTRICTIVE
FOR DELETE
TO authenticated
USING (false);

-- 2. Make voice_samples bucket private to protect user voice recordings
UPDATE storage.buckets SET public = false WHERE id = 'voice_samples';

-- 3. Add RLS policy for authenticated users to read their own voice samples via signed URLs
CREATE POLICY "Users can read their own voice samples"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'voice_samples' 
  AND (storage.foldername(name))[1] = auth.uid()::text
);