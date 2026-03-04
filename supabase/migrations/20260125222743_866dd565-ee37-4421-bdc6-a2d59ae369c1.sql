-- Add restrictive INSERT policy to prevent authenticated users from creating fake subscriptions
-- Only the service role (used by stripe-webhook edge function) should be able to insert subscriptions

CREATE POLICY "Deny direct subscription inserts" 
ON public.subscriptions 
FOR INSERT 
TO authenticated
WITH CHECK (false);

-- Also add UPDATE restriction - only service role should update subscriptions
CREATE POLICY "Deny direct subscription updates" 
ON public.subscriptions 
FOR UPDATE 
TO authenticated
USING (false)
WITH CHECK (false);