-- Enable FORCE ROW LEVEL SECURITY on user_api_keys table
-- This ensures RLS policies are enforced even for service role access
ALTER TABLE public.user_api_keys FORCE ROW LEVEL SECURITY;