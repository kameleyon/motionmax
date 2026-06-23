-- ============================================================================
-- api_check_rate_limit — Postgres-backed sliding-window limiter for /api/v1
-- ============================================================================
-- The /api/v1 gateway runs as STATELESS Vercel (Node) functions, so a rate
-- limiter cannot keep per-key counters in process memory — the state has to
-- live in Postgres. This migration adds a single SECURITY DEFINER RPC that the
-- Node middleware (api/_shared/rateLimit.ts) calls on every authenticated
-- request. It atomically:
--
--   1. Counts this key's requests in the trailing 60s window (the minute / rpm
--      bucket) and the trailing 86400s window (the day / daily bucket) against
--      public.rate_limits, scoped by key = 'apiv1:'||p_api_key_id.
--   2. If BOTH buckets are under their caps, records the current request by
--      INSERTing exactly one row stamped now() and returns {allowed:true,…}.
--   3. If EITHER bucket is at/over its cap, returns {allowed:false,…} WITHOUT
--      inserting, plus a retry_after_seconds derived from the oldest in-window
--      row of whichever bucket is saturated.
--
-- Window model: this is a true sliding window over row timestamps (count rows
-- newer than now()-interval), not a fixed calendar bucket. It reuses the
-- existing public.rate_limits table + idx_rate_limits_key_created(key,
-- created_at DESC) index, so the two COUNTs are index-only range scans over a
-- single key partition.
--
-- Concurrency: we deliberately COUNT-then-INSERT without FOR UPDATE / advisory
-- locks. Under a burst, two concurrent calls can both observe count = cap-1 and
-- both insert, admitting one request beyond the cap. For an availability-first
-- v1 API limiter that slop is acceptable (it errs toward letting a customer
-- through, never toward a spurious 429), and it avoids serializing every API
-- request on a row lock. A hard cap is still enforced separately at claim time
-- (claim_pending_job per-tenant in-flight cap), so this layer is admission
-- shaping, not the last line of defence.
--
-- Cleanup relies on the existing purge_old_rate_limits() (DELETEs rows older
-- than 24h, already wired into run_data_retention). A thin api_rate_limit_purge
-- wrapper is provided for symmetry / explicit invocation.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.api_check_rate_limit(
  p_api_key_id uuid,
  p_rpm        int,
  p_daily      int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key            text := 'apiv1:' || p_api_key_id::text;
  v_now            timestamptz := now();
  v_minute_start   timestamptz := now() - interval '60 seconds';
  v_day_start      timestamptz := now() - interval '86400 seconds';
  v_minute_count   int;
  v_day_count      int;
  v_oldest_minute  timestamptz;
  v_oldest_day     timestamptz;
  v_reset_minute   timestamptz;
  v_retry_after    int;
  v_remaining_min  int;
  v_remaining_day  int;
BEGIN
  -- Count this key's requests in each trailing window. Both scans ride
  -- idx_rate_limits_key_created over the single 'apiv1:<id>' key partition.
  SELECT COUNT(*) INTO v_minute_count
  FROM public.rate_limits
  WHERE key = v_key
    AND created_at >= v_minute_start;

  SELECT COUNT(*) INTO v_day_count
  FROM public.rate_limits
  WHERE key = v_key
    AND created_at >= v_day_start;

  -- reset_minute_epoch: when the minute window will next have room. If we are
  -- under the minute cap it is simply "60s from now"; if we are at/over it, it
  -- is when the OLDEST in-window row ages out of the 60s window.
  IF v_minute_count >= p_rpm THEN
    SELECT MIN(created_at) INTO v_oldest_minute
    FROM public.rate_limits
    WHERE key = v_key
      AND created_at >= v_minute_start;
    v_reset_minute := COALESCE(v_oldest_minute, v_now) + interval '60 seconds';
  ELSE
    v_reset_minute := v_now + interval '60 seconds';
  END IF;

  -- Blocked when EITHER bucket is saturated. Do not insert.
  IF v_minute_count >= p_rpm OR v_day_count >= p_daily THEN
    -- retry_after = seconds until the saturated bucket's oldest row ages out.
    IF v_minute_count >= p_rpm THEN
      v_retry_after := GREATEST(
        1,
        CEIL(EXTRACT(EPOCH FROM (v_reset_minute - v_now)))::int
      );
    ELSE
      SELECT MIN(created_at) INTO v_oldest_day
      FROM public.rate_limits
      WHERE key = v_key
        AND created_at >= v_day_start;
      v_retry_after := GREATEST(
        1,
        CEIL(EXTRACT(EPOCH FROM (
          (COALESCE(v_oldest_day, v_now) + interval '86400 seconds') - v_now
        )))::int
      );
    END IF;

    RETURN jsonb_build_object(
      'allowed',              false,
      'limit_minute',         p_rpm,
      'remaining_minute',     GREATEST(0, p_rpm - v_minute_count),
      'limit_day',            p_daily,
      'remaining_day',        GREATEST(0, p_daily - v_day_count),
      'reset_minute_epoch',   EXTRACT(EPOCH FROM v_reset_minute)::bigint,
      'retry_after_seconds',  v_retry_after
    );
  END IF;

  -- Admitted: record exactly one row for this request, then report the
  -- post-insert remaining counts.
  INSERT INTO public.rate_limits (key, created_at)
  VALUES (v_key, v_now);

  v_remaining_min := GREATEST(0, p_rpm   - (v_minute_count + 1));
  v_remaining_day := GREATEST(0, p_daily - (v_day_count + 1));

  RETURN jsonb_build_object(
    'allowed',             true,
    'limit_minute',        p_rpm,
    'remaining_minute',    v_remaining_min,
    'limit_day',           p_daily,
    'remaining_day',       v_remaining_day,
    'reset_minute_epoch',  EXTRACT(EPOCH FROM v_reset_minute)::bigint,
    'retry_after_seconds', 0
  );
END;
$$;

-- The /api/v1 gateway calls this with the service-role client only. Revoke the
-- ambient PUBLIC execute grant and re-grant to service_role explicitly.
REVOKE EXECUTE ON FUNCTION public.api_check_rate_limit(uuid, int, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.api_check_rate_limit(uuid, int, int) TO service_role;

-- Thin explicit wrapper over the existing 24h purge, for symmetry with the
-- rest of the api_* surface. run_data_retention still drives the real cleanup.
CREATE OR REPLACE FUNCTION public.api_rate_limit_purge()
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.purge_old_rate_limits();
$$;

REVOKE EXECUTE ON FUNCTION public.api_rate_limit_purge() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.api_rate_limit_purge() TO service_role;

COMMIT;
