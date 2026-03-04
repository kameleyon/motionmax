-- Drop the overly permissive SELECT policy that exposes all share data
DROP POLICY IF EXISTS "Anyone can view by share token" ON public.project_shares;

-- Drop the overly permissive UPDATE policy that allows anyone to modify view counts
DROP POLICY IF EXISTS "Anyone can update view count" ON public.project_shares;

-- Note: The get_shared_project() function is SECURITY DEFINER and bypasses RLS,
-- so anonymous users can still access shared projects via that RPC function.
-- Direct table access is now restricted to:
-- 1. Authenticated users viewing their own shares (existing policy)
-- 2. The service role (for internal operations)

-- The existing policies remain:
-- - "Users can view their own shares" (SELECT where auth.uid() = user_id)
-- - "Users can create their own shares" (INSERT where auth.uid() = user_id)
-- - "Users can delete their own shares" (DELETE where auth.uid() = user_id)