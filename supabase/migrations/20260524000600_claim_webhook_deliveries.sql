-- Atomic, cross-replica-safe claim for the customer-webhook delivery sweep.
--
-- Replaces the prior non-atomic SELECT-then-conditional-UPDATE in
-- worker/src/lib/webhookDelivery.ts, which (a) let two worker replicas claim and
-- deliver the SAME row (double-delivery — the fleet runs multiple replicas), and
-- (b) let a worker that crashes after the soft-lock but before recording the
-- outcome re-deliver the row indefinitely without ever advancing attempts.
--
-- This UPDATE ... FOR UPDATE SKIP LOCKED claims rows EXCLUSIVELY across replicas,
-- pushes next_attempt_at forward by a lease (so a crashed 'delivering' row is not
-- re-claimed for the lease window), and increments attempts AT CLAIM TIME so even
-- a delivery that crashes before recording still walks toward max_attempts and
-- terminates. `AND attempts < max_attempts` stops re-claiming an exhausted row.

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(
  p_limit         int DEFAULT 20,
  p_lease_seconds int DEFAULT 60
)
RETURNS SETOF public.webhook_deliveries
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.webhook_deliveries d
  SET status          = 'delivering',
      attempts        = d.attempts + 1,
      next_attempt_at = now() + make_interval(secs => p_lease_seconds)
  WHERE d.id IN (
    SELECT id
    FROM public.webhook_deliveries
    WHERE status IN ('pending', 'delivering')
      AND next_attempt_at <= now()
      AND attempts < max_attempts
    ORDER BY next_attempt_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  RETURNING d.*;
END;
$$;

REVOKE ALL    ON FUNCTION public.claim_webhook_deliveries(int, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_deliveries(int, int) TO service_role;

COMMIT;
