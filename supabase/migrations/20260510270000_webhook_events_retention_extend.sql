-- ============================================================
-- Wave E-Legal Part E: extend webhook_events retention from 7 → 90 days
--
-- Background:
--   purge_old_webhook_events() (defined in 20260319000005_fix_purge_column_names.sql)
--   currently deletes webhook_events rows older than 7 days. The 7-day
--   window matches the Stripe idempotency-key TTL — long enough for any
--   in-flight retry from Stripe, but far too short for tax / financial
--   compliance investigations.
--
--   The IRS general record-retention guidance for billing-related records
--   is 7 years (26 CFR 1.6001-1); EU member-state VAT regimes typically
--   require 10 years (e.g. Germany §147 AO, France LPF Art. L102B). The
--   long-tail retention is already covered by the
--   `stripe_processed_invoices` table (migration 20260510240100), whose
--   rows are never deleted — that is the canonical financial audit trail
--   keyed on Stripe invoice id.
--
--   Where webhook_events still matters for compliance is the operational
--   layer: the raw webhook payload + processed_at timestamp + which
--   handler ran is what proves "this credit grant came from THIS Stripe
--   event with THIS signature". For tax / chargeback / refund investi-
--   gations that typically need to look back ~30–90 days, 7 days is far
--   too short. 90 days is the right operational window; the immutable
--   invoice id in stripe_processed_invoices is the long-term record.
--
-- This migration:
--   1. Redefines purge_old_webhook_events() with a 90-day window.
--   2. Comments the new retention rationale on the function so the next
--      reader does not redo the same debate.
--   3. Does NOT touch the cron schedule — the
--      'webhook-events-retention' cron job set up in
--      20260510250300_system_logs_retention_consolidation.sql continues
--      to call this function nightly; only the window inside it changes.
--
-- Safety:
--   • Idempotent: CREATE OR REPLACE.
--   • No data is deleted by this migration itself; the next cron run
--     will simply delete fewer rows (rows aged 7–90 days now survive).
--   • stripe_processed_invoices is untouched; that table has no
--     retention policy and serves as the permanent invoice ledger.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.purge_old_webhook_events()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted INT;
BEGIN
  -- 90 days: Wave E-Legal Part E. Operational window for tax /
  -- chargeback / refund investigations. The permanent financial
  -- audit trail is stripe_processed_invoices (no retention policy).
  DELETE FROM webhook_events
   WHERE processed_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

COMMENT ON FUNCTION public.purge_old_webhook_events() IS
  'Deletes webhook_events rows older than 90 days. Operational ledger '
  'for tax / chargeback investigations; permanent invoice audit trail '
  'lives in stripe_processed_invoices. See migration 20260510270000 for '
  'the retention-window rationale.';

COMMIT;
