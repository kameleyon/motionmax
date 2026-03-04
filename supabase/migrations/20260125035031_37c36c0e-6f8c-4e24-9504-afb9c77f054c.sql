-- COMPREHENSIVE SECURITY FIX FOR BOTH TABLES

-- ============ user_api_keys ============
ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_api_keys FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_api_keys FROM anon;
REVOKE ALL ON public.user_api_keys FROM public;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_api_keys TO authenticated;

-- ============ user_credits ============
ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_credits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_credits FROM anon;
REVOKE ALL ON public.user_credits FROM public;
GRANT SELECT ON public.user_credits TO authenticated;

-- Drop any existing anon deny policies and recreate them cleanly
DROP POLICY IF EXISTS "Block all anonymous access" ON public.user_api_keys;
DROP POLICY IF EXISTS "Deny anonymous access to user_api_keys" ON public.user_api_keys;
DROP POLICY IF EXISTS "Deny anonymous access to user_credits" ON public.user_credits;

-- Create explicit deny policies for anon role
CREATE POLICY "anon_blocked_user_api_keys"
ON public.user_api_keys
AS RESTRICTIVE
FOR ALL
TO anon
USING (false)
WITH CHECK (false);

CREATE POLICY "anon_blocked_user_credits"
ON public.user_credits
AS RESTRICTIVE
FOR ALL
TO anon
USING (false)
WITH CHECK (false);