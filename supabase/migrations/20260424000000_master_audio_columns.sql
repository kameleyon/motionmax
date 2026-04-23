-- Master-audio columns for doc2video + cinematic.
--
-- Context: previously every scene produced its own TTS call (15× per
-- generation). This (a) burned Gemini quota in seconds and frequently
-- failed on 3+ scenes per run, (b) broke continuity — each scene was
-- recorded cold so tonality/pacing jumped between scenes. Now we
-- generate ONE master audio track per project (150s for short/brief,
-- 280s for presentation/long) covering the entire script, and scenes
-- share the same URL with duration slices computed at export time.
--
-- Smartflow is unaffected — it's always been single-scene.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS master_audio_url text,
  ADD COLUMN IF NOT EXISTS master_audio_duration_ms integer;

COMMENT ON COLUMN public.generations.master_audio_url IS
  'Single continuous narration track for doc2video + cinematic. One
   Gemini Flash TTS call per project instead of one per scene.
   Smartflow continues to use per-scene audioUrl (still only 1 scene).';

COMMENT ON COLUMN public.generations.master_audio_duration_ms IS
  'ffprobed duration of master_audio_url in milliseconds. Used by the
   export step to stretch scene image/video clips proportionally so
   total visual time matches the audio.';
