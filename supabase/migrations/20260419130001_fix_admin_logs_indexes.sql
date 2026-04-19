-- Repair: migration 20260327000002 created indexes for columns admin_user_id and
-- action_type that do not exist. The actual columns are admin_id and action.
-- Create the missing indexes using the correct names.

CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_id
  ON public.admin_logs(admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_logs_action
  ON public.admin_logs(action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at
  ON public.admin_logs(created_at DESC);
