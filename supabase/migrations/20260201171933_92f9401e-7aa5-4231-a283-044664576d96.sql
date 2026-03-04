-- Create table for tracking API calls
CREATE TABLE public.api_call_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  generation_id uuid,
  user_id uuid NOT NULL,
  provider text NOT NULL, -- openrouter, replicate, hypereal, google_tts
  model text NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- pending, running, succeeded, failed
  queue_time_ms integer,
  running_time_ms integer,
  total_duration_ms integer,
  cost numeric DEFAULT 0,
  error_message text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.api_call_logs ENABLE ROW LEVEL SECURITY;

-- Admins can view all logs
CREATE POLICY "Admins can view all api_call_logs"
  ON public.api_call_logs
  FOR SELECT
  USING (is_admin(auth.uid()));

-- Service role can insert logs
CREATE POLICY "Service role can insert api_call_logs"
  ON public.api_call_logs
  FOR INSERT
  WITH CHECK (true);

-- Deny anonymous access
CREATE POLICY "Deny anonymous access to api_call_logs"
  ON public.api_call_logs
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

-- Create index for faster queries
CREATE INDEX idx_api_call_logs_created_at ON public.api_call_logs(created_at DESC);
CREATE INDEX idx_api_call_logs_provider ON public.api_call_logs(provider);
CREATE INDEX idx_api_call_logs_status ON public.api_call_logs(status);