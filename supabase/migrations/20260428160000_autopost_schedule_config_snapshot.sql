-- Migration: autopost_schedule_config_snapshot
--
-- Adds a `config_snapshot` jsonb column to autopost_schedules so the
-- intake form can stash a verbatim copy of the user's IntakeSettings
-- (visualStyle, tone, captionStyle, voice, language, etc.) at the
-- moment the schedule was created.
--
-- Why a SHADOW COPY? When pg_cron's autopost_tick() pops a topic off
-- the queue every minute and inserts a video_generation_jobs row with
-- task_type='autopost_render', the worker needs the original creative
-- prefs to reproduce the look/feel the user signed up for. Without a
-- snapshot, edits to the schedule (changed prompt, swapped voice)
-- silently rewrite history for already-queued runs. Snapshot is
-- frozen at insert and read on every pop.
--
-- Mirrors Autonomux's `config.title_generation_context` pattern. We
-- do NOT add a NOT NULL constraint — legacy schedules created before
-- this migration are still valid and should fall back to defaults.
--
-- Idempotent (IF NOT EXISTS) so re-running the migration is a no-op.

ALTER TABLE public.autopost_schedules
  ADD COLUMN IF NOT EXISTS config_snapshot JSONB;

COMMENT ON COLUMN public.autopost_schedules.config_snapshot
  IS 'Frozen IntakeSettings snapshot taken at schedule creation. Worker reads this on each autopost_render job so edits to the schedule do not retroactively rewrite the look of already-queued runs.';
