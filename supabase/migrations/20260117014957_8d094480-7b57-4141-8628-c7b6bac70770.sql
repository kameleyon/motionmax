-- Fix missing SELECT policy for user_api_keys
CREATE POLICY "Authenticated users can view their own API keys"
ON public.user_api_keys
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Secure user_credits table - restrict modifications to service role only
-- Drop existing SELECT policy and recreate with proper security
DROP POLICY IF EXISTS "Users can view their own credits" ON public.user_credits;

-- Force RLS
ALTER TABLE public.user_credits FORCE ROW LEVEL SECURITY;

-- Users can only view their own credits
CREATE POLICY "Authenticated users can view their own credits"
ON public.user_credits
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Only service role can insert credits (for backend processes)
CREATE POLICY "Service role can insert credits"
ON public.user_credits
FOR INSERT
TO service_role
WITH CHECK (true);

-- Only service role can update credits (for backend processes)
CREATE POLICY "Service role can update credits"
ON public.user_credits
FOR UPDATE
TO service_role
USING (true)
WITH CHECK (true);

-- Only service role can delete credits (for backend processes)
CREATE POLICY "Service role can delete credits"
ON public.user_credits
FOR DELETE
TO service_role
USING (true);