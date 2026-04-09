-- RPC function to get generation costs summary.
-- SECURITY DEFINER bypasses RLS so the admin dashboard can read costs
-- without needing complex policy chains.
CREATE OR REPLACE FUNCTION public.get_generation_costs_summary()
RETURNS JSON
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'openrouter', COALESCE(SUM(openrouter_cost), 0),
    'replicate', COALESCE(SUM(replicate_cost), 0),
    'hypereal', COALESCE(SUM(hypereal_cost), 0),
    'google_tts', COALESCE(SUM(google_tts_cost), 0),
    'total', COALESCE(SUM(total_cost), 0),
    'row_count', COUNT(*)
  )
  FROM generation_costs
$$;

GRANT EXECUTE ON FUNCTION public.get_generation_costs_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_generation_costs_summary() TO service_role;
