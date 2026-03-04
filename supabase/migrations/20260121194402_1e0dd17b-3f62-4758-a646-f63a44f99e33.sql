-- Enable FORCE ROW LEVEL SECURITY on remaining tables
-- This ensures RLS policies are enforced even for service role access

-- Projects table
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;

-- Subscriptions table
ALTER TABLE public.subscriptions FORCE ROW LEVEL SECURITY;

-- User credits table (already has service role policies)
ALTER TABLE public.user_credits FORCE ROW LEVEL SECURITY;

-- Credit transactions table
ALTER TABLE public.credit_transactions FORCE ROW LEVEL SECURITY;

-- Profiles table
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;