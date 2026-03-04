-- Create system_logs table for user activity events and system errors
CREATE TABLE public.system_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  event_type text NOT NULL,
  category text NOT NULL CHECK (category IN ('user_activity', 'system_error', 'system_warning', 'system_info')),
  message text NOT NULL,
  details jsonb,
  generation_id uuid,
  project_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;

-- Force RLS for all roles
ALTER TABLE public.system_logs FORCE ROW LEVEL SECURITY;

-- Revoke all permissions from anon and public
REVOKE ALL ON public.system_logs FROM anon;
REVOKE ALL ON public.system_logs FROM public;

-- Allow admins to view all logs
CREATE POLICY "Admins can view all system_logs"
  ON public.system_logs
  FOR SELECT
  USING (is_admin(auth.uid()));

-- Deny anonymous access for SELECT
CREATE POLICY "Deny anon select system_logs"
  ON public.system_logs
  FOR SELECT
  TO anon
  USING (false);

-- Deny anonymous access for INSERT
CREATE POLICY "Deny anon insert system_logs"
  ON public.system_logs
  FOR INSERT
  TO anon
  WITH CHECK (false);

-- Deny anonymous access for UPDATE
CREATE POLICY "Deny anon update system_logs"
  ON public.system_logs
  FOR UPDATE
  TO anon
  USING (false)
  WITH CHECK (false);

-- Deny anonymous access for DELETE
CREATE POLICY "Deny anon delete system_logs"
  ON public.system_logs
  FOR DELETE
  TO anon
  USING (false);

-- Create index for faster queries
CREATE INDEX idx_system_logs_created_at ON public.system_logs (created_at DESC);
CREATE INDEX idx_system_logs_category ON public.system_logs (category);
CREATE INDEX idx_system_logs_user_id ON public.system_logs (user_id);
CREATE INDEX idx_system_logs_event_type ON public.system_logs (event_type);