-- Restrict the videos bucket to video-only uploads with a 500 MB per-file cap.
-- The previous config allowed audio/mpeg, image/png, image/jpeg (2 GB limit)
-- which enabled free storage abuse under a user's own folder.
-- Authenticated users upload source files to separate buckets (audio, source_uploads);
-- only the worker (service_role) should write final rendered MP4/WebM files.

UPDATE storage.buckets
SET
  file_size_limit  = 524288000,  -- 500 MB
  allowed_mime_types = ARRAY['video/mp4', 'video/webm']
WHERE id = 'videos';
