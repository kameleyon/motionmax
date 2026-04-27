-- Heal projects whose voice_name was set to a user clone's friendly name
-- (e.g. "Jomama") but whose voice_type / voice_id columns were never
-- populated correctly. Caused by an older write path in
-- resolveVoiceForProject that silently wrote the picker value as
-- voice_name without setting voice_type='custom' + voice_id=<external>.
--
-- Without this heal, handleCinematicAudio's clone short-circuit at
-- line 191 (which requires voice_type='custom' AND voice_id non-null)
-- doesn't trigger for affected projects, and the handler falls through
-- to the "voice not supported" rejection branch — failing the entire
-- generation and triggering an automatic credit refund.
--
-- The matching join is by (user_id, voice_name) — only the clones the
-- user actually owns get linked. Built-in speakers like "Adam"/"River"
-- never match a user_voices row so they're untouched.
--
-- Idempotent: the WHERE guard skips rows already in the correct shape.

UPDATE public.projects p
   SET voice_type = 'custom',
       voice_id   = uv.voice_id
  FROM public.user_voices uv
 WHERE p.user_id = uv.user_id
   AND p.voice_name = uv.voice_name
   AND (p.voice_type IS DISTINCT FROM 'custom' OR p.voice_id IS NULL);
