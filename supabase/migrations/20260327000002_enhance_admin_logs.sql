-- Enhance admin_logs table to track all admin actions
-- This may already exist, so use CREATE TABLE IF NOT EXISTS

CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  affected_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  affected_resource_type TEXT,
  affected_resource_id TEXT,
  details JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_user
  ON admin_logs(admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_logs_affected_user
  ON admin_logs(affected_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_logs_action_type
  ON admin_logs(action_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_logs_created
  ON admin_logs(created_at DESC);

-- Row Level Security
ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;

-- Only admins can read admin logs
CREATE POLICY "Admins can view all logs" ON admin_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_roles.user_id = auth.uid()
      AND user_roles.role = 'admin'
    )
  );

-- Service role can insert logs
CREATE POLICY "Service can insert logs" ON admin_logs
  FOR INSERT
  WITH CHECK (true);

COMMENT ON TABLE admin_logs IS 'Audit log of all admin actions for security and compliance';
COMMENT ON COLUMN admin_logs.action_type IS 'Type of action: view_user_details, toggle_feature_flag, view_revenue_stats, etc.';
COMMENT ON COLUMN admin_logs.affected_resource_type IS 'Type of resource: user, feature_flag, subscription, etc.';
