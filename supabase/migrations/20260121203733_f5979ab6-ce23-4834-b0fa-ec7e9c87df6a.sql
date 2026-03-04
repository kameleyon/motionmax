-- Force RLS on user_api_keys to prevent unauthorized access to API tokens
ALTER TABLE public.user_api_keys FORCE ROW LEVEL SECURITY;

-- Force RLS on generations to prevent public access to user content
ALTER TABLE public.generations FORCE ROW LEVEL SECURITY;