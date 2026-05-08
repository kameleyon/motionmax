-- ============================================================
-- Phase 9.4 — Generations search via payload jsonb_path_ops
-- ============================================================
-- The admin Generations tab searches by id / user / prompt across
-- video_generation_jobs.payload. Without an index, an ILIKE on a
-- 50k-row table sequence-scans the JSONB column.
--
-- jsonb_path_ops is the right operator class for containment-style
-- queries (`payload @> '{"prompt": ...}'`) and is much smaller on disk
-- than the default jsonb_ops. We use IF NOT EXISTS so the migration is
-- safe to re-run after a manual creation.
--
-- The query the index supports:
--   SELECT * FROM video_generation_jobs
--   WHERE payload @? '$.** ? (@ like_regex "<term>" flag "i")';
-- The admin RPC may also fall back to a plain ILIKE on payload::text
-- for small result sets — the planner picks based on selectivity.

BEGIN;

CREATE INDEX IF NOT EXISTS payload_search_idx
  ON public.video_generation_jobs
  USING gin (payload jsonb_path_ops);

COMMIT;
