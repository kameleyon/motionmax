-- ============================================================
-- C-7-14 / Ghost G-C5: cross-tab regen debounce (DB-backed)
-- ============================================================
--
-- WHY:
--   useSceneRegen kept the debounce in a per-hook
--   `useRef<Map<string, number>>` — purely in-memory, per-tab. Two
--   open tabs of the same editor both pass their local debounce and
--   both fire the same regen → two Hypereal (image) or Kling (video)
--   calls billed for one visible output. The user pays twice; one of
--   the two writes "wins" and the other is orphaned.
--
--   This table is a server-side shared lock. Insert with ON CONFLICT
--   DO NOTHING; if 0 rows inserted, a sibling tab already kicked off
--   the regen and we surface "already in flight" instead of firing a
--   second call.
--
-- TTL:
--   Rows are auto-cleaned by a pg_cron job every minute (rows older
--   than 1 minute are deleted). The partial unique index uses
--   `created_at > NOW() - INTERVAL '30 seconds'`-equivalent semantics
--   in the RPC (we check created_at in the function body), so a stale
--   30s+ row never blocks a fresh regen.

CREATE TABLE IF NOT EXISTS public.regen_debounce (
  key TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS regen_debounce_created_idx
  ON public.regen_debounce(created_at);
CREATE INDEX IF NOT EXISTS regen_debounce_user_idx
  ON public.regen_debounce(user_id, created_at DESC);

ALTER TABLE public.regen_debounce ENABLE ROW LEVEL SECURITY;
-- Users can read their own debounce rows (handy for debugging from
-- the client) but never write directly — writes go through the RPC.
DROP POLICY IF EXISTS "Users can read own debounce rows" ON public.regen_debounce;
CREATE POLICY "Users can read own debounce rows"
  ON public.regen_debounce
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.regen_debounce IS
  'C-7-14: shared cross-tab regen debounce. Key = user_id + scene_id + kind. Insert via try_acquire_regen_debounce() RPC; row TTL = 30s logical, deleted by cron after 1 min.';

-- ============================================================
-- try_acquire_regen_debounce(p_key TEXT, p_ttl_seconds INT)
-- ============================================================
-- Atomic CAS: returns TRUE if the calling tab successfully acquired
-- the regen slot (and the row was inserted/refreshed). Returns FALSE
-- if a sibling tab is already mid-flight (row exists and is younger
-- than p_ttl_seconds).
--
-- The "refresh stale row" branch lets a regen that started 31s+ ago
-- be replaced — covers the case where the original tab closed before
-- the response landed and the lock would otherwise hang for 60s.
CREATE OR REPLACE FUNCTION public.try_acquire_regen_debounce(
  p_key TEXT,
  p_ttl_seconds INTEGER DEFAULT 30
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_rows INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_key IS NULL OR p_key = '' THEN
    RAISE EXCEPTION 'debounce key required';
  END IF;

  -- Single-statement upsert with a freshness condition. If a row
  -- exists AND it's still fresh, the DO UPDATE clause filters with
  -- WHERE so nothing changes and ROW_COUNT = 0 → we return FALSE.
  -- If the row is stale (older than TTL) or absent, the row count
  -- is 1 and we return TRUE.
  INSERT INTO public.regen_debounce (key, user_id, created_at)
  VALUES (p_key, v_user_id, NOW())
  ON CONFLICT (key) DO UPDATE
    SET created_at = NOW(),
        user_id = EXCLUDED.user_id
    WHERE public.regen_debounce.created_at < NOW() - (p_ttl_seconds || ' seconds')::INTERVAL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_acquire_regen_debounce(TEXT, INTEGER) TO authenticated;
COMMENT ON FUNCTION public.try_acquire_regen_debounce IS
  'C-7-14: server-side cross-tab debounce. Returns true if the caller acquired the regen slot, false if a sibling tab is already running an identical regen.';

-- ============================================================
-- Cleanup cron: drop rows older than 1 minute every minute
-- ============================================================
-- Keeps the table tiny. The 30s TTL is enforced by the RPC's WHERE
-- clause above; this cron is purely housekeeping so the row count
-- never grows unbounded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Best-effort unschedule of any prior version of this job.
    PERFORM cron.unschedule(jobname)
      FROM cron.job
     WHERE jobname = 'cleanup_regen_debounce';

    PERFORM cron.schedule(
      'cleanup_regen_debounce',
      '* * * * *',  -- every minute
      $body$DELETE FROM public.regen_debounce WHERE created_at < NOW() - INTERVAL '1 minute';$body$
    );
  END IF;
END;
$$;
