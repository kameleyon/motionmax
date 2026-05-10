-- ============================================================
-- C-6-3 / Shield S-007 / Trace / Ghost G-M2 — server-side auth throttle
-- ============================================================
--
-- The previous lockout lived in a React useRef inside src/hooks/useAuth.ts:
-- 5 failed attempts → 30s lockout, scoped to the in-memory tab state.
-- F5 / new tab / new device reset the counter, so credential-stuffing
-- trivially defeated the limit. We need server-side enforcement.
--
-- This migration adds:
--   1. public.auth_throttle  — durable per-key attempt + lockout state.
--   2. public.check_and_record_auth_attempt(p_key, p_success)
--      — single round-trip "record + decide" SECURITY DEFINER RPC.
--      Returns:
--        { allowed boolean, attempts_remaining int, locked_until ts }
--   3. RLS that denies anon + authenticated direct table reads/writes —
--      only service_role + the SECURITY DEFINER RPC can touch the row.
--
-- Key derivation (frontend responsibility — see useAuth.ts):
--   • Pre-signin → "email:<lowercased-email>"
--     Lookup is on email rather than user_id so we can reject the
--     attempt BEFORE Supabase Auth would reveal that the email exists.
--     This also prevents email enumeration via timing.
--   • Per-IP fallback for clients sending no email yet (rare).
--     Less effective behind a CDN — see docs/admin-mfa.md follow-up
--     note about routing signin through a custom Edge Function.
--
-- Threshold:
--   • 5 failed attempts → 30 minute lockout.
--   • Successful signin → reset attempts to 0.
-- Matches the original React-state policy with a stronger lockout
-- window (30 min vs 30s) because the server enforcement makes longer
-- windows usable — a single legitimate user who fat-fingered won't be
-- locked out forever because successful signin resets the counter.
--
-- The 30-min window is also paired with the frontend keeping an in-
-- memory soft-lockout for UX (prevent rapid retry button spam). That
-- frontend layer is purely UX; this RPC is the enforcement layer.

BEGIN;

-- ── Table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auth_throttle (
  key              TEXT        PRIMARY KEY,
  attempts         INTEGER     NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ NULL,
  last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index supporting periodic cleanup of stale rows.
CREATE INDEX IF NOT EXISTS idx_auth_throttle_last_attempt
  ON public.auth_throttle (last_attempt_at);

COMMENT ON TABLE public.auth_throttle IS
  'C-6-3 / Shield S-007 — per-key (typically per-email) auth attempt counter + lockout. Read/write exclusively via public.check_and_record_auth_attempt.';

-- ── RLS — service_role only ──────────────────────────────────────────
ALTER TABLE public.auth_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_throttle FORCE ROW LEVEL SECURITY;

-- Drop any prior policy with the same name so the migration is
-- idempotent in re-run scenarios.
DROP POLICY IF EXISTS "auth_throttle_service_role_only" ON public.auth_throttle;

CREATE POLICY "auth_throttle_service_role_only"
  ON public.auth_throttle
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Explicitly revoke from anon + authenticated so anyone who somehow
-- holds a JWT cannot enumerate emails by SELECTing the table directly.
REVOKE ALL ON public.auth_throttle FROM anon;
REVOKE ALL ON public.auth_throttle FROM authenticated;
GRANT  ALL ON public.auth_throttle TO service_role;

-- ── RPC ──────────────────────────────────────────────────────────────
-- Single round-trip: callers pass the key plus whether this call
-- represents a SUCCESS or a FAILED attempt.
--
--   p_success = true  → reset attempts, clear locked_until.
--   p_success = false → if currently locked, return { allowed = false };
--                       else increment attempts; if attempts >= 5,
--                       set locked_until = now() + 30 minutes and
--                       return { allowed = false }; else return
--                       { allowed = true } with attempts_remaining.
--
-- The RPC is SECURITY DEFINER so it can write to the table even when
-- called from an anon JWT (pre-signin). search_path is locked to
-- (public, pg_catalog) per the §6-C standard.
--
-- Important: callers should invoke this once BEFORE
-- supabase.auth.signInWithPassword with p_success = false to record
-- the pre-attempt and check for an existing lockout. Then call again
-- AFTER signin with the actual outcome.

DROP FUNCTION IF EXISTS public.check_and_record_auth_attempt(text, boolean);

CREATE OR REPLACE FUNCTION public.check_and_record_auth_attempt(
  p_key     TEXT,
  p_success BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_now              TIMESTAMPTZ := now();
  v_max_attempts     INT         := 5;
  v_lockout_interval INTERVAL    := INTERVAL '30 minutes';
  v_row              public.auth_throttle%ROWTYPE;
  v_attempts_remaining INT;
BEGIN
  IF p_key IS NULL OR length(p_key) = 0 OR length(p_key) > 256 THEN
    RAISE EXCEPTION 'check_and_record_auth_attempt: p_key required and must be <= 256 chars'
      USING ERRCODE = '22023';
  END IF;

  -- Upsert the row, taking a row-level lock to serialise concurrent
  -- attempts on the same key. ON CONFLICT … DO UPDATE returns the
  -- updated row so we can branch on its state below.
  INSERT INTO public.auth_throttle (key, attempts, last_attempt_at)
    VALUES (p_key, 0, v_now)
  ON CONFLICT (key) DO UPDATE
    SET last_attempt_at = v_now
  RETURNING * INTO v_row;

  -- If the row is currently locked AND we're not recording a success,
  -- reject before mutating attempts further. A success during lockout
  -- (theoretically impossible if the client gates correctly, but we
  -- defend against bad clients) clears the lockout.
  IF v_row.locked_until IS NOT NULL AND v_row.locked_until > v_now THEN
    IF p_success THEN
      -- Successful signin during the lockout window — Supabase Auth
      -- accepted the password, so reset. Without this, a user who
      -- ultimately remembered their password would stay locked.
      UPDATE public.auth_throttle
         SET attempts       = 0,
             locked_until   = NULL,
             last_attempt_at = v_now
       WHERE key = p_key
       RETURNING * INTO v_row;
      RETURN jsonb_build_object(
        'allowed', true,
        'attempts_remaining', v_max_attempts,
        'locked_until', NULL
      );
    END IF;
    -- Locked + still failing → deny.
    RETURN jsonb_build_object(
      'allowed', false,
      'attempts_remaining', 0,
      'locked_until', v_row.locked_until
    );
  END IF;

  -- Not currently locked. Apply the outcome.
  IF p_success THEN
    UPDATE public.auth_throttle
       SET attempts       = 0,
           locked_until   = NULL,
           last_attempt_at = v_now
     WHERE key = p_key
     RETURNING * INTO v_row;
    RETURN jsonb_build_object(
      'allowed', true,
      'attempts_remaining', v_max_attempts,
      'locked_until', NULL
    );
  ELSE
    UPDATE public.auth_throttle
       SET attempts        = COALESCE(v_row.attempts, 0) + 1,
           last_attempt_at = v_now,
           locked_until    = CASE
             WHEN COALESCE(v_row.attempts, 0) + 1 >= v_max_attempts
               THEN v_now + v_lockout_interval
             ELSE NULL
           END
     WHERE key = p_key
     RETURNING * INTO v_row;

    v_attempts_remaining := GREATEST(v_max_attempts - v_row.attempts, 0);

    RETURN jsonb_build_object(
      'allowed', v_row.locked_until IS NULL OR v_row.locked_until <= v_now,
      'attempts_remaining', v_attempts_remaining,
      'locked_until', v_row.locked_until
    );
  END IF;
END;
$func$;

-- Allow the function to be invoked by anon (pre-signin) and
-- authenticated callers. The SECURITY DEFINER body is the only path
-- that touches the table; direct table access is denied by RLS.
REVOKE ALL ON FUNCTION public.check_and_record_auth_attempt(TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_and_record_auth_attempt(TEXT, BOOLEAN) TO anon;
GRANT EXECUTE ON FUNCTION public.check_and_record_auth_attempt(TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_record_auth_attempt(TEXT, BOOLEAN) TO service_role;

COMMENT ON FUNCTION public.check_and_record_auth_attempt(TEXT, BOOLEAN) IS
  'C-6-3 / Shield S-007 — record an auth attempt against a throttle key (typically "email:<lowercased-email>") and return whether the caller may proceed. SECURITY DEFINER; the underlying auth_throttle table is service_role-only.';

-- ── Cleanup helper ───────────────────────────────────────────────────
-- Periodic purge of stale rows (no activity in the last 7 days and
-- not currently locked). Called by run_data_retention (or directly
-- in pg_cron).
CREATE OR REPLACE FUNCTION public.purge_old_auth_throttle()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  deleted INT;
BEGIN
  DELETE FROM public.auth_throttle
   WHERE last_attempt_at < now() - INTERVAL '7 days'
     AND (locked_until IS NULL OR locked_until < now());
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_old_auth_throttle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_old_auth_throttle() TO service_role;

COMMENT ON FUNCTION public.purge_old_auth_throttle() IS
  'C-6-3 / Shield S-007 — periodically prune auth_throttle rows older than 7 days that are not currently locked.';

COMMIT;
