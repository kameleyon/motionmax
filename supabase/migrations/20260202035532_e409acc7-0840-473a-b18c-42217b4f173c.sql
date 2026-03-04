
-- Fix overly permissive RLS policies that claim to be for service role but apply to public

-- Fix api_call_logs: Drop and recreate with proper service_role target
DROP POLICY IF EXISTS "Service role can insert api_call_logs" ON public.api_call_logs;

CREATE POLICY "Service role can insert api_call_logs"
ON public.api_call_logs
FOR INSERT
TO service_role
WITH CHECK (true);

-- Fix generation_costs: Drop and recreate with proper service_role target
DROP POLICY IF EXISTS "Service role can insert costs" ON public.generation_costs;

CREATE POLICY "Service role can insert costs"
ON public.generation_costs
FOR INSERT
TO service_role
WITH CHECK (true);
