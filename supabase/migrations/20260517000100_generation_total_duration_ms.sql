-- Add total_duration_ms to generations.
--
-- Stamped by handleFinalize.ts at completion time. The dashboard's
-- minutes-generated strip (Projects.tsx) used to walk every scene's
-- _meta.audioDurationMs which required pulling the full scenes jsonb
-- (multi-MB per row × 100 rows = statement-timeout). We migrated to
-- summing master_audio_duration_ms (commit d62d677), but that misses
-- legacy/per-scene-audio projects that don't have a master audio track.
-- A dedicated total_duration_ms column lets the dashboard query a
-- single numeric per row regardless of pipeline variant.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS total_duration_ms integer;

COMMENT ON COLUMN public.generations.total_duration_ms IS
  'Total visual duration of the generation in milliseconds. Stamped at
   finalize time. For master-audio pipelines (doc2video/cinematic since
   2026-03) this equals master_audio_duration_ms; for legacy/per-scene-
   audio rows this is the sum of scene durations (handleFinalize sums
   _meta.audioDurationMs). Dashboard reads this column instead of
   scanning the scenes jsonb (which statement-times out under load).';

-- Backfill from master_audio_duration_ms where available — cheap, single
-- column-to-column copy on rows that already have the master-audio row.
UPDATE public.generations
SET total_duration_ms = master_audio_duration_ms
WHERE total_duration_ms IS NULL
  AND master_audio_duration_ms IS NOT NULL;
