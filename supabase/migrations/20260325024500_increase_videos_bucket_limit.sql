-- Increase the 'videos' bucket file_size_limit from 500 MB to 2 GB
-- to support large cinematic exports (20+ scenes with audio).
-- TUS resumable upload handles chunked transfer for files above 50 MB.
UPDATE storage.buckets
SET file_size_limit = 2147483648  -- 2 GB
WHERE id = 'videos';
