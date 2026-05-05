-- ============================================================
-- Admin rebuild — Phase 2.7: RLS hardening on existing tables
-- ============================================================
-- WHAT: Adds admin SELECT policies to nine existing tables that
--       currently lack them, and replaces the deny-all SELECT on
--       rate_limits with an admin-gated SELECT. Also creates the
--       safe admin view for user_api_keys exposing only metadata.
--
--       Tables hardened:
--         feature_flags
--         deletion_requests
--         webhook_events
--         referral_codes
--         referral_uses
--         rate_limits          (replace deny-all with admin gate)
--         voice_consents
--         scene_versions
--         project_characters
--
--       Plus: admin_v_user_api_keys safe view (NEVER plaintext).
--
-- WHY:  The admin tabs need to read these tables for fraud review,
--       compliance, kill switches, etc. RLS today denies admin
--       SELECT — admin-stats had to use service-role short-circuits.
--       Add explicit admin SELECT policies so we can drop the
--       service-role escape hatches in later migrations.
--
-- IMPLEMENTS: ADMIN_REBUILD_CHECKLIST.md section 2.7.
--
-- IDEMPOTENCY: each policy uses DROP POLICY IF EXISTS + CREATE.
-- ============================================================

BEGIN;

-- ── feature_flags ────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'feature_flags' AND relnamespace = 'public'::regnamespace) THEN
    DROP POLICY IF EXISTS ff_admin_select ON public.feature_flags;
    CREATE POLICY ff_admin_select ON public.feature_flags
      FOR SELECT TO authenticated
      USING (public.is_admin(auth.uid()));
  END IF;
END; $$;

-- ── deletion_requests ────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'deletion_requests' AND relnamespace = 'public'::regnamespace) THEN
    DROP POLICY IF EXISTS dr_admin_select ON public.deletion_requests;
    CREATE POLICY dr_admin_select ON public.deletion_requests
      FOR SELECT TO authenticated
      USING (public.is_admin(auth.uid()));
  END IF;
END; $$;

-- ── webhook_events ───────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'webhook_events' AND relnamespace = 'public'::regnamespace) THEN
    DROP POLICY IF EXISTS we_admin_select ON public.webhook_events;
    CREATE POLICY we_admin_select ON public.webhook_events
      FOR SELECT TO authenticated
      USING (public.is_admin(auth.uid()));
  END IF;
END; $$;

-- ── referral_codes ───────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'referral_codes' AND relnamespace = 'public'::regnamespace) THEN
    DROP POLICY IF EXISTS rc_admin_select ON public.referral_codes;
    CREATE POLICY rc_admin_select ON public.referral_codes
      FOR SELECT TO authenticated
      USING (public.is_admin(auth.uid()));
  END IF;
END; $$;

-- ── referral_uses ────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'referral_uses' AND relnamespace = 'public'::regnamespace) THEN
    DROP POLICY IF EXISTS ru_admin_select ON public.referral_uses;
    CREATE POLICY ru_admin_select ON public.referral_uses
      FOR SELECT TO authenticated
      USING (public.is_admin(auth.uid()));
  END IF;
END; $$;

-- ── rate_limits — replace deny-all with admin gate ───────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'rate_limits' AND relnamespace = 'public'::regnamespace) THEN
    -- Drop any policies that match the legacy USING (false) shape;
    -- the policy names differ across migrations so we drop a few
    -- known variants then add ours.
    DROP POLICY IF EXISTS "Deny all rate_limits"            ON public.rate_limits;
    DROP POLICY IF EXISTS "Deny anon select rate_limits"    ON public.rate_limits;
    DROP POLICY IF EXISTS "Deny anonymous access to rate_limits" ON public.rate_limits;
    DROP POLICY IF EXISTS rl_admin_select                   ON public.rate_limits;

    CREATE POLICY rl_admin_select ON public.rate_limits
      FOR SELECT TO authenticated
      USING (public.is_admin(auth.uid()));
  END IF;
END; $$;

-- ── voice_consents ───────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'voice_consents' AND relnamespace = 'public'::regnamespace) THEN
    DROP POLICY IF EXISTS vc_admin_select ON public.voice_consents;
    CREATE POLICY vc_admin_select ON public.voice_consents
      FOR SELECT TO authenticated
      USING (public.is_admin(auth.uid()));
  END IF;
END; $$;

-- ── scene_versions ───────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'scene_versions' AND relnamespace = 'public'::regnamespace) THEN
    DROP POLICY IF EXISTS sv_admin_select ON public.scene_versions;
    CREATE POLICY sv_admin_select ON public.scene_versions
      FOR SELECT TO authenticated
      USING (public.is_admin(auth.uid()));
  END IF;
END; $$;

-- ── project_characters ───────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'project_characters' AND relnamespace = 'public'::regnamespace) THEN
    DROP POLICY IF EXISTS pc_admin_select ON public.project_characters;
    CREATE POLICY pc_admin_select ON public.project_characters
      FOR SELECT TO authenticated
      USING (public.is_admin(auth.uid()));
  END IF;
END; $$;

-- ── admin_v_user_api_keys (safe metadata-only view) ──────────
-- Exposes only presence flags and timestamps. NEVER ciphertext.
-- Schema of public.user_api_keys (per existing migrations) is:
--   user_id uuid, gemini_key text, replicate_key text, updated_at
-- The view returns (user_id, has_gemini, has_replicate, updated_at).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'user_api_keys'
      AND relnamespace = 'public'::regnamespace
  ) THEN
    EXECUTE $ddl$
      CREATE OR REPLACE VIEW public.admin_v_user_api_keys
      WITH (security_invoker = true) AS
      SELECT
        k.user_id,
        (k.gemini_api_key      IS NOT NULL AND length(k.gemini_api_key)      > 0) AS has_gemini,
        (k.replicate_api_token IS NOT NULL AND length(k.replicate_api_token) > 0) AS has_replicate,
        k.updated_at
      FROM public.user_api_keys k
      WHERE public.is_admin(auth.uid())
    $ddl$;

    REVOKE ALL    ON public.admin_v_user_api_keys FROM anon;
    GRANT  SELECT ON public.admin_v_user_api_keys TO authenticated;
  END IF;
END;
$$;

COMMIT;
