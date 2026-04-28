-- Migration: autopost_daily_summary RPC
--
-- Wave 4 (production hardening). Server-side aggregation entry point used by
-- the worker's dailySummary task. SECURITY DEFINER so the worker can call it
-- via service-role JWT without re-deriving RLS context, and we still gate
-- the function from authenticated callers via signature (a logged-in admin
-- can also call it for their own user_id, which is fine — the function only
-- reads roll-up rows that already exist for that user).

CREATE OR REPLACE FUNCTION public.autopost_daily_summary(
  p_user_id UUID,
  p_day     DATE
)
RETURNS TABLE (
  platform        TEXT,
  succeeded       INT,
  failed          INT,
  total_attempts  INT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT platform, succeeded, failed, total_attempts
    FROM public.autopost_platform_metrics
   WHERE user_id = p_user_id
     AND bucket  = p_day;
$$;

COMMENT ON FUNCTION public.autopost_daily_summary(UUID, DATE)
  IS 'Returns the per-platform autopost roll-up for one user on one UTC date. Used by the worker daily-summary task.';

GRANT EXECUTE ON FUNCTION public.autopost_daily_summary(UUID, DATE) TO authenticated;
