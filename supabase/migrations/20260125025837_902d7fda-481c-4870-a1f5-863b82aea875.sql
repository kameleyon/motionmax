-- Add explicit policy to deny anonymous access to projects table
-- This ensures anonymous users cannot access any project data

CREATE POLICY "Deny anonymous access to projects" 
ON public.projects 
AS RESTRICTIVE
FOR ALL 
TO anon
USING (false)
WITH CHECK (false);

-- Ensure FORCE ROW LEVEL SECURITY is enabled
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;