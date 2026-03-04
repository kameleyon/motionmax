-- Make voice_samples bucket private
UPDATE storage.buckets SET public = false WHERE id = 'voice_samples';