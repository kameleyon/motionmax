-- Lyria-generated SFX / ambient bed track per generation.
--
-- When the user toggles `intake.music.sfx` ON, handleFinalize calls
-- Lyria 3 Pro a SECOND time with an ambient/foley-oriented prompt
-- (room tone, atmospheric wash, no melody). Result is stored here and
-- mixed into the export at low volume (~0.10) alongside the music bed
-- which rides at ~0.15. Both ducked under narration via
-- sidechaincompress.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS sfx_url text;

COMMENT ON COLUMN public.generations.sfx_url IS
  'Lyria-generated ambient SFX bed. One call per generation, mixed
   into the export under the narration. Null when user opted out of
   SFX or when Lyria failed (non-fatal — export proceeds without).';
