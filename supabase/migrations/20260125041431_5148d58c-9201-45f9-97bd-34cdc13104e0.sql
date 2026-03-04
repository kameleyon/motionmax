-- Strictly lock down anon access to sensitive per-user tables

BEGIN;

-- Ensure RLS is enabled
ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;

-- 1) Permission-level block (reject anon before RLS)
REVOKE ALL ON TABLE public.user_api_keys FROM anon;
REVOKE ALL ON TABLE public.user_credits FROM anon;

-- 2) Force RLS as an additional safety belt
ALTER TABLE public.user_api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_credits FORCE ROW LEVEL SECURITY;

-- 3) RESTRICTIVE fail-safe policies (AND semantics)
DO $$
BEGIN
  DROP POLICY IF EXISTS "Deny anonymous access to user_api_keys" ON public.user_api_keys;
END $$;

CREATE POLICY "Deny anonymous access to user_api_keys"
ON public.user_api_keys
AS RESTRICTIVE
FOR ALL
TO anon
USING (false)
WITH CHECK (false);

DO $$
BEGIN
  DROP POLICY IF EXISTS "Deny anonymous access to user_credits" ON public.user_credits;
END $$;

CREATE POLICY "Deny anonymous access to user_credits"
ON public.user_credits
AS RESTRICTIVE
FOR ALL
TO anon
USING (false)
WITH CHECK (false);

COMMIT;