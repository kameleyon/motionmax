-- ============================================================
-- Migration: Add webhook_events table + increment_user_credits RPC
-- Fixes: stripe-webhook/index.ts references to missing DB objects
-- ============================================================

-- 1. webhook_events — Stripe idempotency guard
--    Referenced by stripe-webhook at lines 100-117
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id           UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id     TEXT UNIQUE NOT NULL,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stripe_signature TEXT,
  raw_payload  JSONB
);

-- Indexes for fast lookup and cleanup
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id
  ON public.webhook_events(event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed_at
  ON public.webhook_events(processed_at DESC);

-- RLS: only service_role should touch this table
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.webhook_events FROM anon, public, authenticated;
GRANT ALL ON public.webhook_events TO service_role;

-- 2. increment_user_credits — atomic credit upsert
--    Called by stripe-webhook at line 162
CREATE OR REPLACE FUNCTION public.increment_user_credits(
  p_user_id UUID,
  p_credits INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO user_credits (user_id, credits_balance, total_purchased)
  VALUES (p_user_id, p_credits, p_credits)
  ON CONFLICT (user_id) DO UPDATE
  SET credits_balance  = user_credits.credits_balance + p_credits,
      total_purchased  = user_credits.total_purchased + p_credits,
      updated_at       = NOW();
END;
$$;

-- Lock down: only service_role may call this function
REVOKE ALL ON FUNCTION public.increment_user_credits(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_user_credits(UUID, INT) TO service_role;
