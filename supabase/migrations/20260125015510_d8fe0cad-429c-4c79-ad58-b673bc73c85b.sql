-- Block all anonymous access to credit_transactions
CREATE POLICY "Deny anonymous access to credit_transactions"
ON public.credit_transactions
AS RESTRICTIVE
FOR ALL
TO anon
USING (false)
WITH CHECK (false);

-- Block all anonymous access to user_api_keys
CREATE POLICY "Deny anonymous access to user_api_keys"
ON public.user_api_keys
AS RESTRICTIVE
FOR ALL
TO anon
USING (false)
WITH CHECK (false);

-- Ensure FORCE ROW LEVEL SECURITY is enabled (applies policies to all roles including table owner)
ALTER TABLE public.credit_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_api_keys FORCE ROW LEVEL SECURITY;