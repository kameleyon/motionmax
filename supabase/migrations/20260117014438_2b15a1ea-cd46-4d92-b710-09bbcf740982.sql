-- ========================================
-- 1. SECURE SUBSCRIPTIONS TABLE
-- ========================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view their own subscription" ON public.subscriptions;

-- Enable and force RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions FORCE ROW LEVEL SECURITY;

-- Create secure policy - only authenticated users can view their own subscription
CREATE POLICY "Authenticated users can view their own subscription"
ON public.subscriptions
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- ========================================
-- 2. SECURE PROFILES TABLE
-- ========================================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can create their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;

-- Force RLS
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

-- Create secure policies with TO authenticated
CREATE POLICY "Authenticated users can view their own profile"
ON public.profiles
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Authenticated users can create their own profile"
ON public.profiles
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Authenticated users can update their own profile"
ON public.profiles
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Authenticated users can delete their own profile"
ON public.profiles
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- ========================================
-- 3. ADD DELETE POLICIES FOR GENERATIONS
-- ========================================

-- Drop existing policies and recreate with proper security
DROP POLICY IF EXISTS "Users can view their own generations" ON public.generations;
DROP POLICY IF EXISTS "Users can create their own generations" ON public.generations;
DROP POLICY IF EXISTS "Users can update their own generations" ON public.generations;

-- Force RLS
ALTER TABLE public.generations FORCE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view their own generations"
ON public.generations
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Authenticated users can create their own generations"
ON public.generations
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Authenticated users can update their own generations"
ON public.generations
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Authenticated users can delete their own generations"
ON public.generations
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- ========================================
-- 4. ADD DELETE POLICY FOR USER_API_KEYS
-- ========================================

-- Drop and recreate all policies to ensure TO authenticated
DROP POLICY IF EXISTS "Authenticated users can view their own API keys" ON public.user_api_keys;
DROP POLICY IF EXISTS "Authenticated users can insert their own API keys" ON public.user_api_keys;
DROP POLICY IF EXISTS "Authenticated users can update their own API keys" ON public.user_api_keys;
DROP POLICY IF EXISTS "Authenticated users can delete their own API keys" ON public.user_api_keys;

CREATE POLICY "Authenticated users can delete their own API keys"
ON public.user_api_keys
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);