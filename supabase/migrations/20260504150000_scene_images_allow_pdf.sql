-- Allow PDF uploads in the scene-images bucket so source attachments
-- (research PDFs, magazines, papers) can be uploaded from the browser
-- and fetched by the worker for pdf-parse extraction.
--
-- Prior prod state (confirmed via storage.buckets at apply time):
--   allowed_mime_types = [image/png, image/jpeg, image/jpg, image/webp]
--   file_size_limit    = 10485760  (10 MB)
--
-- Any PDF the user attached was rejected at upload time on BOTH counts
-- (MIME-type and size), so the worker never got a [PDF_URL] tag — the
-- UI surfaced "PDF upload failed — content not extractable" and the
-- worker had nothing to parse.
--
-- We add application/pdf to the allowlist and lift file_size_limit to
-- 256 MB. Magazine and book PDFs routinely run 80–150 MB; 256 MB gives
-- comfortable ceiling without inviting abuse (worker pdf-parse latency
-- past that gets ugly).

UPDATE storage.buckets
SET
  allowed_mime_types = ARRAY[
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'application/pdf'
  ],
  file_size_limit = 268435456  -- 256 MB (round 2^28)
WHERE id = 'scene-images';
