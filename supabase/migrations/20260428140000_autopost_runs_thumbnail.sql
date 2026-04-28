-- Migration: autopost_runs_thumbnail
--
-- Wave 3c addition: per-run thumbnail capture so the run history list
-- can render a real preview frame from the rendered video (not the
-- placeholder still). The worker generates a 360x640 jpeg from the
-- rendered video at duration/2 and uploads it to a public storage
-- bucket. Two columns are added — a public URL for direct rendering
-- and the storage path so future garbage-collection / re-upload logic
-- can target it deterministically.
--
-- Also creates the public 'autopost-thumbnails' storage bucket (idempotent)
-- and a permissive read policy on it. Thumbnails are previews of
-- AI-generated marketing content; nothing user-private is exposed by
-- making them public, and a public bucket means the lab UI can render
-- them with no signed-URL roundtrip.
--
-- Re-running the migration is safe: ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, ON CONFLICT DO NOTHING for the bucket
-- insert, and DROP/CREATE for the storage policy.

-- ============================================================
-- 1. New columns on autopost_runs
-- ============================================================
ALTER TABLE public.autopost_runs
  ADD COLUMN IF NOT EXISTS thumbnail_url          TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_storage_path TEXT;

COMMENT ON COLUMN public.autopost_runs.thumbnail_url
  IS 'Public URL of a 360x640 jpeg poster frame extracted from the rendered video. Populated opportunistically by the autopost dispatcher; NULL until first publish attempt.';
COMMENT ON COLUMN public.autopost_runs.thumbnail_storage_path
  IS 'Storage path inside the autopost-thumbnails bucket. Used for cleanup / re-upload.';

-- ============================================================
-- 2. Index for the run history filter (status + reverse chrono)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_autopost_runs_status_fired_at
  ON public.autopost_runs (status, fired_at DESC);

-- ============================================================
-- 3. Public storage bucket for thumbnails
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('autopost-thumbnails', 'autopost-thumbnails', true)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 4. Public read policy on the bucket
-- ============================================================
DROP POLICY IF EXISTS "public read autopost thumbnails" ON storage.objects;
CREATE POLICY "public read autopost thumbnails"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'autopost-thumbnails');
