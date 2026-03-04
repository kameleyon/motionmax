-- Secure user_credits table
REVOKE ALL ON public.user_credits FROM anon, public;
ALTER TABLE public.user_credits FORCE ROW LEVEL SECURITY;

-- Secure user_api_keys table  
REVOKE ALL ON public.user_api_keys FROM anon, public;
ALTER TABLE public.user_api_keys FORCE ROW LEVEL SECURITY;