-- Migration: autopost_pgcron_placeholder
--
-- Wave 1 placeholder: ensures the pg_cron extension is enabled in the
-- Supabase project so that Wave 2b can register the per-minute
-- `autopost_tick` job without a separate manual step.
--
-- The actual cron.schedule(...) call for `autopost_tick` lives in a
-- later migration (Phase 6 of AUTOPOST_ROADMAP.md), once the
-- autopost_tick() function is defined.
--
-- This migration is idempotent and safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_cron;
