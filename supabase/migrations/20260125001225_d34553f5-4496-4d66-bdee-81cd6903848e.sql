-- Enforce RLS for ALL roles including service role
ALTER TABLE public.subscriptions FORCE ROW LEVEL SECURITY;

-- Add explicit deny policy for anonymous users
CREATE POLICY "Deny anonymous access to subscriptions"
ON public.subscriptions
FOR ALL
TO anon
USING (false)
WITH CHECK (false);