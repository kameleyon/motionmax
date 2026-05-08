-- ============================================================
-- Phase 16 + 17 — Announcement clicks, kill-switch enforcement,
-- feature-flag metadata, signups_disabled trigger gate
-- ============================================================
-- Closes the deferred kill-switch + announcement items:
--   16.4 — announcement_clicks table for CTA tracking
--   17.3 — handle_new_user gates on feature_flags 'signups_disabled'
--   17.4 — admin_v_feature_flags view + rollout/audience columns +
--          admin_update_flag_metadata RPC
--
-- Worker / edge-fn checks for the other 7 kill-switches (video_,
-- voice_, image_generation, newsletter, payments, maint, autopost)
-- ship in companion code commits — this migration only adds the
-- DB-side pieces.

BEGIN;

-- ── 16.4 announcement_clicks ────────────────────────────────────────
-- Logged by the new `announcement-click` edge function. Each row =
-- one user clicking the CTA on an announcement. The Announcements
-- tab's CTA-click-rate KPI computes count(distinct user_id) /
-- count(distinct dismissals_or_views) across the announcement's
-- active window.
CREATE TABLE IF NOT EXISTS public.announcement_clicks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ip              text,
  user_agent      text,
  clicked_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS announcement_clicks_announcement_clicked_idx
  ON public.announcement_clicks (announcement_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS announcement_clicks_user_idx
  ON public.announcement_clicks (user_id, clicked_at DESC)
  WHERE user_id IS NOT NULL;

ALTER TABLE public.announcement_clicks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS announcement_clicks_admin_select ON public.announcement_clicks;
CREATE POLICY announcement_clicks_admin_select ON public.announcement_clicks
  FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
DROP POLICY IF EXISTS announcement_clicks_service_insert ON public.announcement_clicks;
CREATE POLICY announcement_clicks_service_insert ON public.announcement_clicks
  FOR INSERT TO service_role WITH CHECK (true);

-- ── 17.3 handle_new_user — signups_disabled gate ────────────────────
-- Wraps the existing signup trigger so flipping the kill switch
-- bounces new auth.users.INSERT mid-flight. Existing sessions are
-- untouched. The function is idempotent — if `signups_disabled` is
-- absent from feature_flags, signups proceed (fail-open).
CREATE OR REPLACE FUNCTION public.signups_kill_switch_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_armed boolean;
BEGIN
  SELECT enabled INTO v_armed
    FROM public.feature_flags
   WHERE flag_name = 'signups_disabled';
  IF COALESCE(v_armed, false) THEN
    RAISE EXCEPTION 'Sign-ups are temporarily disabled by an administrator. Please try again later.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS check_signups_disabled ON auth.users;
CREATE TRIGGER check_signups_disabled
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.signups_kill_switch_check();

-- ── 17.4 feature_flags rollout + audience metadata ──────────────────
ALTER TABLE public.feature_flags
  ADD COLUMN IF NOT EXISTS rollout_pct int  DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS audience    jsonb DEFAULT '{"all": true}'::jsonb;

-- 17.4 view: feature flag with active-users count for the audience.
-- Keep the count cheap — just a stamped denormalised value calculated
-- on read, scoped to opted-in / non-deleted profiles. For audience
-- predicates we don't yet evaluate (e.g. plan='studio'), the count
-- falls back to total profiles.
CREATE OR REPLACE VIEW public.admin_v_feature_flags
WITH (security_invoker = true) AS
SELECT
  f.flag_name,
  f.enabled,
  f.description,
  f.rollout_pct,
  f.audience,
  f.updated_by,
  f.updated_at,
  -- Audience-affected user count. Cheap heuristic: when audience.plan
  -- is set, count subscribers on that plan. Otherwise total non-deleted
  -- profiles. The Kill Switches tab uses this for the "active users"
  -- column — exact-match isn't required for an operator-facing UI.
  CASE
    WHEN f.audience ? 'plan' THEN (
      SELECT COUNT(*) FROM public.subscriptions s
       WHERE s.status IN ('active','trialing')
         AND COALESCE(s.plan_name, '') ILIKE '%' || (f.audience->>'plan') || '%'
    )
    ELSE (
      SELECT COUNT(*) FROM public.profiles p
       WHERE p.deleted_at IS NULL
    )
  END AS active_users
FROM public.feature_flags f;

REVOKE ALL ON public.admin_v_feature_flags FROM anon;
GRANT SELECT ON public.admin_v_feature_flags TO authenticated;

-- 17.4 RPC: edit description / rollout_pct / audience separately from
-- the on/off toggle (which uses admin_set_feature_flag). Same admin
-- gate + same audit row pattern.
CREATE OR REPLACE FUNCTION public.admin_update_flag_metadata(
  p_flag        text,
  p_description text,
  p_rollout_pct int,
  p_audience    jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_update_flag_metadata: forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_rollout_pct IS NOT NULL AND (p_rollout_pct < 0 OR p_rollout_pct > 100) THEN
    RAISE EXCEPTION 'admin_update_flag_metadata: rollout_pct must be 0..100' USING ERRCODE = '22023';
  END IF;

  UPDATE public.feature_flags
     SET description = COALESCE(p_description, description),
         rollout_pct = COALESCE(p_rollout_pct, rollout_pct),
         audience    = COALESCE(p_audience, audience),
         updated_by  = v_admin::text,
         updated_at  = NOW()
   WHERE flag_name = p_flag;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_update_flag_metadata: flag % not found', p_flag USING ERRCODE = '02000';
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'feature_flag.metadata', 'feature_flag', NULL,
          jsonb_build_object('flag', p_flag, 'description', p_description,
                             'rollout_pct', p_rollout_pct, 'audience', p_audience));
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_update_flag_metadata(text, text, int, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_update_flag_metadata(text, text, int, jsonb) TO authenticated;

-- ── 17.3 / 17.4 seed the 8 spec subsystem flags so they appear in
-- the Kill Switches table on first load (instead of empty until an
-- admin clicks each toggle once). All start disabled = false (kill
-- switch idle, feature operational).
INSERT INTO public.feature_flags (flag_name, enabled, description, rollout_pct, audience)
VALUES
  ('maint',             false, 'Site maintenance mode — all non-admin routes return 503.',     100, '{"all": true}'::jsonb),
  ('signups_disabled',  false, 'Block new auth.users INSERTs (existing users unaffected).',     100, '{"all": true}'::jsonb),
  ('video_generation',  false, 'Pause cinematic video generation (Hypereal Seedance/Kling).',   100, '{"all": true}'::jsonb),
  ('image_generation',  false, 'Pause image generation (gpt-image-2 / Replicate fallbacks).',   100, '{"all": true}'::jsonb),
  ('voice_generation',  false, 'Pause voice/TTS generation across all providers.',              100, '{"all": true}'::jsonb),
  ('payments',          false, 'Block Stripe checkout sessions (existing subscriptions OK).',   100, '{"all": true}'::jsonb),
  ('autopost',          false, 'Pause autopost render dispatch (existing runs continue).',      100, '{"all": true}'::jsonb),
  ('newsletter',        false, 'Pause outbound newsletter sender (drafts + scheduled OK).',     100, '{"all": true}'::jsonb)
ON CONFLICT (flag_name) DO NOTHING;

COMMIT;
