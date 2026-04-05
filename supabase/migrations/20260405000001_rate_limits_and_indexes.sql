-- ============================================================
-- 1. Rate limits table (if not exists)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  user_id UUID,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_key_created
  ON public.rate_limits(key, created_at DESC);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits FORCE ROW LEVEL SECURITY;

-- Service role only (edge functions use service role client)
CREATE POLICY "service_role_full_access_rate_limits"
  ON public.rate_limits FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Cleanup old rate limit records (called by run_data_retention)
CREATE OR REPLACE FUNCTION public.purge_old_rate_limits()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM rate_limits WHERE created_at < NOW() - INTERVAL '24 hours';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- ============================================================
-- 2. Missing database indexes for scale
-- ============================================================

-- generations: queried by project_id in every export and display
CREATE INDEX IF NOT EXISTS idx_generations_project_id
  ON public.generations(project_id);

-- generations: queried by status + created_at for admin views
CREATE INDEX IF NOT EXISTS idx_generations_status_created
  ON public.generations(status, created_at DESC);

-- video_generation_jobs: queried by user_id for user's job history
CREATE INDEX IF NOT EXISTS idx_video_generation_jobs_user_id
  ON public.video_generation_jobs(user_id);

-- credit_transactions: queried by type for admin revenue views
CREATE INDEX IF NOT EXISTS idx_credit_transactions_type_created
  ON public.credit_transactions(transaction_type, created_at DESC);

-- webhook_events: queried during cleanup
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed
  ON public.webhook_events(processed_at);
