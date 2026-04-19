-- Reduce system_logs retention from 90 days to 7 days.
-- At 10-20 writes per job this table grows ~600k rows/month; 7 days
-- keeps roughly 1-2 weeks of operational data without unbounded growth.
CREATE OR REPLACE FUNCTION public.purge_old_system_logs()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM system_logs
  WHERE created_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
