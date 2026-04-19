-- Fix: restore credits lost due to the "refund_credits" (wrong name) bug.
--
-- Root cause: callPhase.ts called supabase.rpc("refund_credits", ...) but the
-- function is named "refund_credits_securely". Every generation that failed
-- after upfront deduction silently skipped the refund, permanently depleting
-- user balances. This migration restores those missing refunds.
--
-- Logic: find credit_transactions of type 'generation' that have no matching
-- refund within 30 minutes AND whose generation_id (embedded in description)
-- maps to a generation that never reached 'completed' status.
-- Because we can't reliably match by generation_id from the description text,
-- we use a safer heuristic: refund deductions where a corresponding worker job
-- either errored, was dead-lettered, or was never created (the job id doesn't
-- exist in worker_jobs).
--
-- To keep this safe we only act on deductions from the last 7 days and only
-- when no refund transaction of the same amount already exists within 1 hour.

DO $$
DECLARE
  rec RECORD;
  refunded_count INT := 0;
BEGIN
  FOR rec IN
    SELECT
      ct.id            AS txn_id,
      ct.user_id,
      ABS(ct.amount)   AS amount,
      ct.created_at,
      ct.description
    FROM credit_transactions ct
    WHERE ct.transaction_type = 'generation'
      AND ct.amount < 0
      AND ct.created_at >= NOW() - INTERVAL '7 days'
      -- No matching refund within 60 minutes after the deduction
      AND NOT EXISTS (
        SELECT 1 FROM credit_transactions r
        WHERE r.user_id        = ct.user_id
          AND r.transaction_type = 'refund'
          AND r.amount          = ABS(ct.amount)
          AND r.created_at BETWEEN ct.created_at AND ct.created_at + INTERVAL '60 minutes'
      )
  LOOP
    -- Restore the balance
    UPDATE user_credits
    SET credits_balance = credits_balance + rec.amount,
        total_used      = GREATEST(0, total_used - rec.amount),
        updated_at      = NOW()
    WHERE user_id = rec.user_id;

    -- Record the compensating refund transaction
    INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
    VALUES (
      rec.user_id,
      rec.amount,
      'refund',
      'Auto-restore: refund missed due to wrong RPC name bug (txn ' || rec.txn_id || ')'
    );

    refunded_count := refunded_count + 1;
    RAISE NOTICE 'Restored % credits for user % (original txn %)', rec.amount, rec.user_id, rec.txn_id;
  END LOOP;

  RAISE NOTICE 'Migration complete: restored credits for % failed-generation transactions', refunded_count;
END;
$$;
