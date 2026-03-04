-- Fix missing INSERT and UPDATE policies for user_api_keys table
-- (DELETE policy was added in previous migration, but INSERT/UPDATE were dropped)

-- Recreate INSERT policy
CREATE POLICY "Authenticated users can insert their own API keys"
ON public.user_api_keys
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- Recreate UPDATE policy  
CREATE POLICY "Authenticated users can update their own API keys"
ON public.user_api_keys
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);