-- Per-user dismissal flag for the v2.0 announcement modal.
--
-- Behavior the founder asked for: the modal shows on every login until
-- the user explicitly checks "Don't show this again." Storing this on
-- profiles (rather than localStorage) makes the opt-out survive across
-- devices, browsers, and sessions — a user who dismisses on their
-- laptop won't see it again on their phone.
--
-- NULL  = never dismissed → modal shows on next dashboard mount.
-- non-NULL = dismissed-with-checkbox → modal stays hidden forever.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS dismissed_v2_announcement_at timestamptz;

-- User-callable RPC. Sets the column for auth.uid()'s profile row.
-- Idempotent: re-calling is harmless (timestamp gets bumped).
-- Gated only by RLS on profiles (user can only update own row), no
-- explicit role check needed — a non-authenticated caller fails at
-- auth.uid() returning NULL.
CREATE OR REPLACE FUNCTION public.dismiss_v2_announcement()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'dismiss_v2_announcement: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
  SET dismissed_v2_announcement_at = NOW()
  WHERE user_id = v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_v2_announcement() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dismiss_v2_announcement() TO authenticated;

COMMENT ON FUNCTION public.dismiss_v2_announcement()
  IS 'Sets profiles.dismissed_v2_announcement_at = now() for the calling user. Used by the v2.0 announcement modal "Don''t show this again" checkbox. Idempotent.';
