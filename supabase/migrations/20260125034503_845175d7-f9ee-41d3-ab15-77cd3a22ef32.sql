-- Revoke ALL permissions from anon role on sensitive tables
-- This ensures no anonymous access is possible at the database level

-- Revoke all permissions on user_api_keys table from anon role
REVOKE ALL ON public.user_api_keys FROM anon;

-- Revoke all permissions on user_credits table from anon role  
REVOKE ALL ON public.user_credits FROM anon;

-- Also ensure authenticated users have proper access (grant back to authenticated role)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_api_keys TO authenticated;
GRANT SELECT ON public.user_credits TO authenticated;