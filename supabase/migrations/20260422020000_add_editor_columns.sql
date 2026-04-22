-- Additional columns driving the unified Editor (see
-- player_editor_roadmap.md Phase 0).
--
-- `previous_export_url` — snapshot of the last exported video URL, set
-- by handleExportVideo just BEFORE overwriting the current export.
-- Drives the A/B compare split-view.
--
-- `music_url` — promoted from scenes[0]._meta.musicUrl to a real column
-- so the Editor timeline can fetch + render the music chip without
-- parsing scene metadata.
--
-- `stems` — optional jsonb populated by the v2 stems_export handler
-- with separate voice/music/sfx/captions outputs. Player's audio
-- tab uses this when present.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS previous_export_url text;

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS music_url text,
  ADD COLUMN IF NOT EXISTS stems jsonb;

COMMENT ON COLUMN public.projects.previous_export_url IS
  'Snapshot of the previous exported MP4 URL before the current one was
   written. Drives the Editor A/B compare view.';

COMMENT ON COLUMN public.generations.music_url IS
  'Hypereal Lyria 3 Pro music track URL when the user enabled music in
   the intake form. Null for generations with music off or pre-wiring.';

COMMENT ON COLUMN public.generations.stems IS
  'Per-generation unmixed audio stems and captions VTT. Shape:
   { voiceUrl, musicUrl, sfxUrl, captionsVtt }. Populated by the v2
   stems_export handler.';
