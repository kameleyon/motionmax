-- ============================================================
-- C-9-8: Audit-first stripe-webhook processing
--
-- The original webhook_events row was inserted AFTER handlers ran
-- (best-effort idempotency check). This violates SOC 2 CC7.2 and
-- PCI-DSS 10.2 because a crash between handler-commit and the audit
-- insert leaves a billing mutation on the books with no audit row.
--
-- The supabase/functions/stripe-webhook/index.ts function is being
-- updated to RESERVE the audit row in "processing" state BEFORE
-- handlers run, then flip it to "completed" / "failed" after. This
-- migration adds the supporting columns:
--   - status         text   processing|completed|failed
--   - body_hash      text   sha256 hex of the raw webhook body
--   - completed_at   tstz   when the row moved to a terminal state
--   - error_message  text   error string on failed events
--   - received_at    tstz   when the audit row was first reserved
--
-- Plus a partial index so the admin tab can quickly find
-- "processing" rows older than a few minutes (orphaned by a crashed
-- function invocation) for forensic cleanup.
-- ============================================================

BEGIN;

ALTER TABLE public.webhook_events
  ADD COLUMN IF NOT EXISTS status        TEXT,
  ADD COLUMN IF NOT EXISTS body_hash     TEXT,
  ADD COLUMN IF NOT EXISTS received_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Constrain status to the documented enum so a bug can't silently
-- write a freeform value that breaks downstream dashboards.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'webhook_events_status_chk'
  ) THEN
    ALTER TABLE public.webhook_events
      ADD CONSTRAINT webhook_events_status_chk
      CHECK (status IS NULL OR status IN ('processing', 'completed', 'failed'));
  END IF;
END $$;

-- Partial index for finding orphaned "processing" rows. The webhook
-- function reserves a row, runs handlers (potentially ~30s), then
-- flips to "completed" — anything stuck in "processing" longer than
-- ~5 minutes is almost certainly a crashed invocation that needs
-- forensic investigation.
CREATE INDEX IF NOT EXISTS idx_webhook_events_processing
  ON public.webhook_events (received_at)
  WHERE status = 'processing';

-- Index for the admin Activity Feed's "failed webhooks last 24h" tile.
CREATE INDEX IF NOT EXISTS idx_webhook_events_failed
  ON public.webhook_events (completed_at)
  WHERE status = 'failed';

COMMENT ON COLUMN public.webhook_events.status
  IS 'C-9-8: lifecycle state of this webhook delivery. "processing" = row reserved, handlers running; "completed" = handlers succeeded; "failed" = handlers threw.';
COMMENT ON COLUMN public.webhook_events.body_hash
  IS 'C-9-8: sha256 hex of the raw stripe-signature-verified body, for forensic correlation.';
COMMENT ON COLUMN public.webhook_events.error_message
  IS 'C-9-8: error string captured when status was flipped to "failed". Truncated to 500 chars.';

COMMIT;
