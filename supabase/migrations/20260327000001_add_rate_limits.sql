-- Create rate_limits table for edge function rate limiting
CREATE TABLE IF NOT EXISTS rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookups by key and time window
CREATE INDEX IF NOT EXISTS idx_rate_limits_key_created
  ON rate_limits(key, created_at DESC);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_rate_limits_created
  ON rate_limits(created_at);

-- Row Level Security
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Only service role can access rate limits
CREATE POLICY "Service role only" ON rate_limits
  FOR ALL USING (false);

COMMENT ON TABLE rate_limits IS 'Rate limiting records for edge functions';
