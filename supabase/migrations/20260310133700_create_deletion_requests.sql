-- Account deletion requests with 7-day grace period.
-- Replaces the mailto: flow with a proper audit trail.

CREATE TABLE IF NOT EXISTS deletion_requests (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT,
  requested_at  TIMESTAMPTZ DEFAULT NOW(),
  scheduled_at  TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
  status        TEXT        DEFAULT 'pending'
                  CHECK (status IN ('pending', 'cancelled', 'completed')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;

-- Users can submit their own deletion request
CREATE POLICY "Users can insert own deletion request"
  ON deletion_requests FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can view their own deletion request
CREATE POLICY "Users can view own deletion request"
  ON deletion_requests FOR SELECT
  USING (auth.uid() = user_id);

-- Index for admin queries
CREATE INDEX IF NOT EXISTS deletion_requests_scheduled_idx
  ON deletion_requests (scheduled_at)
  WHERE status = 'pending';
