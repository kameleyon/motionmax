-- Drop the stale deny-all "Service role only" policy left by migration
-- 20260327000001_add_rate_limits.sql. That policy used USING (false) which
-- was superseded by the explicit service_role policy in 20260405000001 but
-- was never removed, leaving two conflicting definitions on the table.
DROP POLICY IF EXISTS "Service role only" ON public.rate_limits;
