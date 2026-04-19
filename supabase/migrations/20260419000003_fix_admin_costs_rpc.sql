-- Restrict get_generation_costs_summary to admin users only.

CREATE OR REPLACE FUNCTION public.get_generation_costs_summary()
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Access denied: admin role required';
  END IF;

  RETURN (
    SELECT json_build_object(
      'openrouter', COALESCE(SUM(openrouter_cost), 0),
      'replicate',  COALESCE(SUM(replicate_cost), 0),
      'hypereal',   COALESCE(SUM(hypereal_cost), 0),
      'google_tts', COALESCE(SUM(google_tts_cost), 0),
      'total',      COALESCE(SUM(total_cost), 0),
      'row_count',  COUNT(*)
    )
    FROM generation_costs
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_generation_costs_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_generation_costs_summary() TO service_role;
