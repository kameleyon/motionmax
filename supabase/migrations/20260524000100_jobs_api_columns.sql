-- Public /api/v1 gateway support columns on public.video_generation_jobs.
--
-- The gateway inserts jobs via the service role and stamps these columns so
-- that:
--   * api_key_id / account_id   — attribute the job to a customer API key and
--                                 its owning account (per-tenant fairness +
--                                 cap joins, usage reporting).
--   * idempotency_key           — caller-supplied retry-dedupe token, scoped
--                                 per api_key_id via a partial unique index.
--   * billed_at                 — set once credits/usage are committed so the
--                                 billing reconciler does not double-charge.
--   * callback_url              — optional webhook the worker POSTs on
--                                 terminal state transitions.
--   * priority                  — higher number served first by the claimer
--                                 (Builder C wires this into claim_pending_job).
--
-- Also extends the status CHECK to allow a first-class 'cancelled' terminal
-- state (today cancels are encoded as status='failed' + error_message), and
-- rebuilds the claimable index to order by priority DESC so the claimer can
-- honor the new column without an extra sort.
--
-- All ADD COLUMNs are nullable / defaulted so they are metadata-only (no table
-- rewrite, no long lock). Idempotent so re-application is a no-op.

BEGIN;

-- ── New columns (non-locking metadata adds) ──────────────────────────────────
ALTER TABLE public.video_generation_jobs
  ADD COLUMN IF NOT EXISTS api_key_id      uuid,
  ADD COLUMN IF NOT EXISTS account_id      uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS billed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS callback_url    text,
  ADD COLUMN IF NOT EXISTS priority        int DEFAULT 0;

-- ── Extend the status CHECK to admit a first-class 'cancelled' state ──────────
-- The original constraint was added in 20260419190001_add_status_enum_checks.sql
-- as chk_video_generation_jobs_status. Drop + recreate, preserving every
-- previously-allowed value.
ALTER TABLE public.video_generation_jobs
  DROP CONSTRAINT IF EXISTS chk_video_generation_jobs_status;

ALTER TABLE public.video_generation_jobs
  ADD CONSTRAINT chk_video_generation_jobs_status
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'));

-- ── Per-key idempotency: at most one live job per (api_key_id, idempotency_key) ─
-- Partial so jobs without an idempotency_key (browser path) are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_video_jobs_api_idempotency
  ON public.video_generation_jobs (api_key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── Rebuild the claimable index to carry priority ────────────────────────────
-- Was (status, created_at ASC) in 20260510120000. Now (status, priority DESC,
-- created_at ASC) so the claimer's FOR UPDATE SKIP LOCKED scan reads rows in
-- priority-then-FIFO order with no extra sort. account_id is INCLUDEd so the
-- per-tenant fairness CTE can read it without a heap visit.
DROP INDEX IF EXISTS public.idx_video_generation_jobs_claimable;

CREATE INDEX IF NOT EXISTS idx_video_generation_jobs_claimable
  ON public.video_generation_jobs (status, priority DESC, created_at ASC)
  INCLUDE (user_id, project_id, task_type, account_id)
  WHERE status = 'pending';

-- ── Make priority NOT NULL so claim ordering never sorts a stray NULL first ───
-- ADD COLUMN … DEFAULT 0 already backfills existing rows with 0 (PG11+ stores a
-- table-level missing-value, no rewrite), but we make it explicit + NOT NULL so
-- claim_pending_job's `ORDER BY priority DESC` can never put a NULL-priority row
-- ahead of real priorities (DESC defaults to NULLS FIRST).
UPDATE public.video_generation_jobs SET priority = 0 WHERE priority IS NULL;
ALTER TABLE public.video_generation_jobs ALTER COLUMN priority SET NOT NULL;

-- NOTE: the partial index backing the per-account in-flight cap aggregate is
-- created in 20260524000200 with the tighter predicate
-- (status='processing' AND account_id IS NOT NULL). It is intentionally NOT
-- duplicated here.

COMMIT;
