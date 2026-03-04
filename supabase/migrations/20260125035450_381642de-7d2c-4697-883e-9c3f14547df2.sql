-- 1. REVOKE all permissions from the anonymous role
-- This is the strongest fix: 'anon' users will be rejected at the permission level
-- before even reaching RLS policies.
REVOKE ALL ON TABLE public.user_api_keys FROM anon;

-- 2. Force Row Level Security (just to be safe)
ALTER TABLE public.user_api_keys FORCE ROW LEVEL SECURITY;

-- 3. Add a RESTRICTIVE RLS policy as a failsafe
-- "AS RESTRICTIVE" means this policy MUST pass for access to be granted,
-- overriding any other permissive policies that might accidentally grant access.
-- We use DO block to safely drop/create the policy.
DO $$ 
BEGIN
    -- Drop existing policy if it exists to allow clean recreation
    DROP POLICY IF EXISTS "Deny anonymous access to user_api_keys" ON public.user_api_keys;
    DROP POLICY IF EXISTS "Deny anonymous SELECT on user_api_keys" ON public.user_api_keys;
    DROP POLICY IF EXISTS "anon_blocked_user_api_keys" ON public.user_api_keys;
    DROP POLICY IF EXISTS "Block all anonymous access" ON public.user_api_keys;
END $$;

-- Create the new restrictive policy
CREATE POLICY "Deny anonymous access to user_api_keys"
ON public.user_api_keys
AS RESTRICTIVE
FOR ALL
TO anon
USING (false)
WITH CHECK (false);