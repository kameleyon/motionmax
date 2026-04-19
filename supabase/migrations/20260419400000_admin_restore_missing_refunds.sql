-- Admin function to restore credits for a single user who was hit by the
-- "refund_credits" (wrong RPC name) bug. Complements the bulk migration
-- 20260419390000_fix_missing_refunds.sql, but scoped to one user so it can
-- be invoked on-demand from the admin panel or SQL editor.
--
-- Usage from SQL editor (as service_role):
--   SELECT public.admin_restore_missing_refunds('d53d98fb-e712-4160-b170-12539c5a23d0'::uuid, 7);
--
-- Arguments:
--   p_user_id      — affected user
--   p_days_back    — how many days of deductions to review (default 14)
--
-- Returns: total credits restored.

CREATE OR REPLACE FUNCTION public.admin_restore_missing_refunds(
  p_user_id   UUID,
  p_days_back INT DEFAULT 14
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  rec RECORD;
  total_restored INT := 0;
BEGIN
  -- Only service_role may invoke this function (auth.uid() is NULL for
  -- service_role calls; authenticated callers are rejected).
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'unauthorized: admin_restore_missing_refunds is service_role only';
  END IF;

  FOR rec IN
    SELECT
      ct.id          AS txn_id,
      ABS(ct.amount) AS amount,
      ct.created_at
    FROM credit_transactions ct
    WHERE ct.user_id = p_user_id
      AND ct.transaction_type = 'generation'
      AND ct.amount < 0
      AND ct.created_at >= NOW() - (p_days_back || ' days')::INTERVAL
      AND NOT EXISTS (
        SELECT 1 FROM credit_transactions r
        WHERE r.user_id          = p_user_id
          AND r.transaction_type = 'refund'
          AND r.amount           = ABS(ct.amount)
          AND r.created_at BETWEEN ct.created_at AND ct.created_at + INTERVAL '60 minutes'
      )
  LOOP
    UPDATE user_credits
    SET credits_balance = credits_balance + rec.amount,
        total_used      = GREATEST(0, total_used - rec.amount),
        updated_at      = NOW()
    WHERE user_id = p_user_id;

    INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
    VALUES (
      p_user_id,
      rec.amount,
      'refund',
      'Admin restore: refund missed due to wrong RPC name bug (txn ' || rec.txn_id || ')'
    );

    total_restored := total_restored + rec.amount;
  END LOOP;

  RETURN total_restored;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_restore_missing_refunds(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_restore_missing_refunds(UUID, INT) FROM authenticated;
REVOKE ALL ON FUNCTION public.admin_restore_missing_refunds(UUID, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_restore_missing_refunds(UUID, INT) TO service_role;
