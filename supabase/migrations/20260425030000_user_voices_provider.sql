-- Add provider tracking + original sample storage path to user_voices.
--
-- Why:
--   We're swapping the voice-cloning backend from ElevenLabs to Fish
--   Audio (s2-pro). Existing rows hold ElevenLabs voice ids that ONLY
--   work with ElevenLabs' API; new rows hold Fish model ids that ONLY
--   work with Fish's API. The audio router needs to know which one
--   the row is so it picks the right TTS endpoint.
--
--   `original_sample_path` lets the backfill script find each row's
--   source audio (already in the `voice_samples` storage bucket) and
--   re-clone it through Fish so existing users don't lose their voice.

ALTER TABLE public.user_voices
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'elevenlabs',
  ADD COLUMN IF NOT EXISTS original_sample_path TEXT;

-- Backfill the storage path from sample_url when it's a public storage
-- URL — saves the migration script a parsing step. URLs that aren't
-- recognisable (legacy or external) are left null and the backfill
-- script will skip them.
UPDATE public.user_voices
SET original_sample_path = regexp_replace(
  sample_url,
  '^https?://[^/]+/storage/v1/object/(?:public|sign)/voice_samples/',
  ''
)
WHERE original_sample_path IS NULL
  AND sample_url ILIKE '%/voice_samples/%';

-- Constrain provider to known values so a typo can't slip in via a
-- service-role insert. New providers can extend the set later.
ALTER TABLE public.user_voices
  DROP CONSTRAINT IF EXISTS user_voices_provider_check;
ALTER TABLE public.user_voices
  ADD CONSTRAINT user_voices_provider_check
  CHECK (provider IN ('elevenlabs', 'fish'));

COMMENT ON COLUMN public.user_voices.provider IS
  'Which TTS service holds the cloned voice: elevenlabs (legacy) or fish (current).';
COMMENT ON COLUMN public.user_voices.original_sample_path IS
  'Storage path inside the voice_samples bucket (e.g. {user_id}/{ts}-{name}.mp3). Used by the Fish backfill to re-clone old ElevenLabs voices.';
