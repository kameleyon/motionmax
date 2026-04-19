-- Fix: add UNIQUE constraint on webhook_events.event_id for Stripe idempotency guard
ALTER TABLE public.webhook_events
  ADD CONSTRAINT IF NOT EXISTS webhook_events_event_id_unique UNIQUE (event_id);
