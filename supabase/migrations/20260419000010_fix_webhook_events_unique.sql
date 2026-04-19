-- Fix: add UNIQUE constraint on webhook_events.event_id for Stripe idempotency guard
-- Without this, concurrent webhook deliveries for the same event_id bypass the
-- idempotency check and insert duplicate rows.
-- Uses a DO block because ALTER TABLE … ADD CONSTRAINT has no IF NOT EXISTS clause.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhook_events_event_id_unique'
      AND conrelid = 'public.webhook_events'::regclass
  ) THEN
    ALTER TABLE public.webhook_events
      ADD CONSTRAINT webhook_events_event_id_unique UNIQUE (event_id);
  END IF;
END;
$$;
