-- ============================================================
-- EMERGENCY: disarm production kill switches
-- ============================================================
-- The image_generation / video_generation / voice_generation flags
-- ended up enabled=true (probably toggled at some point) and were
-- silently failing every cinematic_image job. The original
-- 20260508210000 seed used ON CONFLICT DO NOTHING so it didn't
-- override. This migration force-disarms them.
--
-- Production-side: I also flipped them via the admin UI / direct
-- SQL out-of-band, but checking this in so the next env (staging,
-- a fresh dev DB) doesn't ship with the same wrong state baked in
-- on first import.

BEGIN;

UPDATE public.feature_flags
   SET enabled = false,
       updated_at = NOW(),
       updated_by = 'emergency-disarm-2026-05-08'
 WHERE flag_name IN (
   'image_generation',
   'video_generation',
   'voice_generation',
   'newsletter',
   'autopost',
   'payments',
   'signups_disabled',
   'maint'
 )
   AND enabled = true;

COMMIT;
