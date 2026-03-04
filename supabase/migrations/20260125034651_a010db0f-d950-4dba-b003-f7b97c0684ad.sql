-- Ensure RLS is fully enforced on user_api_keys table

-- 1. Enable RLS (if not already enabled)
ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;

-- 2. Force RLS for ALL roles including table owner
ALTER TABLE public.user_api_keys FORCE ROW LEVEL SECURITY;

-- 3. Revoke ALL permissions from anon and public roles
REVOKE ALL ON public.user_api_keys FROM anon;
REVOKE ALL ON public.user_api_keys FROM public;

-- 4. Ensure only authenticated users have access via RLS policies
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_api_keys TO authenticated;

-- 5. Drop and recreate the deny policy to ensure it's properly configured
DROP POLICY IF EXISTS "Deny anonymous access to user_api_keys" ON public.user_api_keys;

CREATE POLICY "Block all anonymous access"
ON public.user_api_keys
AS RESTRICTIVE
FOR ALL
TO anon
USING (false)
WITH CHECK (false);