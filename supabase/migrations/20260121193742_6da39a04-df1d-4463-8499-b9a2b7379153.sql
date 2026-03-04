-- Enable FORCE ROW LEVEL SECURITY on generations table
-- This ensures RLS policies are enforced even for service role access
ALTER TABLE public.generations FORCE ROW LEVEL SECURITY;