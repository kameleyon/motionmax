-- Drop existing policies to recreate with proper security
DROP POLICY IF EXISTS "Users can insert their own API keys" ON public.user_api_keys;
DROP POLICY IF EXISTS "Users can update their own API keys" ON public.user_api_keys;
DROP POLICY IF EXISTS "Users can view their own API keys" ON public.user_api_keys;

-- Ensure RLS is enabled
ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;

-- Force RLS for table owners too (prevents bypassing RLS)
ALTER TABLE public.user_api_keys FORCE ROW LEVEL SECURITY;

-- Create secure policies that explicitly require authentication
-- SELECT: Only authenticated users can view their own keys
CREATE POLICY "Authenticated users can view their own API keys"
ON public.user_api_keys
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- INSERT: Only authenticated users can insert their own keys
CREATE POLICY "Authenticated users can insert their own API keys"
ON public.user_api_keys
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- UPDATE: Only authenticated users can update their own keys
CREATE POLICY "Authenticated users can update their own API keys"
ON public.user_api_keys
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- DELETE: Only authenticated users can delete their own keys
CREATE POLICY "Authenticated users can delete their own API keys"
ON public.user_api_keys
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);