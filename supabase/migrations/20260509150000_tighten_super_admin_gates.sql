-- ============================================================
-- Phase 18.5 / 19.5 — tighten high-risk RPC gates to is_super_admin
-- ============================================================
-- Per Phase 18.5 spec, these 4 RPCs should require super_admin role,
-- not just admin. Verified 2026-05-09: all four currently gate on
-- is_admin(v_admin), letting any account with `admin` role engage
-- destructive / org-wide actions.
--
-- Pre-requisite: every account that needs to keep operating these
-- RPCs must already have a `super_admin` row in user_roles. The
-- promotion query was applied 2026-05-09 ahead of this migration:
--   INSERT INTO public.user_roles (user_id, role)
--   SELECT existing.user_id, 'super_admin'::app_role
--     FROM public.user_roles existing WHERE existing.role = 'admin'
--   ON CONFLICT (user_id, role) DO NOTHING;
-- (Result: 1 row promoted — the founder account
-- 3fceb518-fa61-453b-a856-70353828d9ac.)
--
-- This migration also threads a per-call request_id UUID into the
-- admin_logs.details jsonb so multi-step flows (e.g. master kill →
-- admin_cancel_all_active_jobs side-effect) share an ID. Closes the
-- "0 of 58 admin_logs rows include request_id" finding from the
-- 2026-05-09 audit pass.
--
-- Rate-limit budget per RPC follows the existing
-- public.admin_rate_limit_check helper (default 60/min):
--   • master_kill        → 5/min  (aggressive — emergency only)
--   • feature_flag_set   → 60/min (default)
--   • flag_metadata      → 60/min (default)
--   • grant_credits      → 60/min (default)

BEGIN;

-- ── admin_set_master_kill_switch ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_set_master_kill_switch(p_enabled boolean, p_message text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE
  v_admin      uuid := auth.uid();
  v_request_id uuid := gen_random_uuid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_super_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_set_master_kill_switch: super_admin required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.admin_rate_limit_check('master_kill', 5);

  UPDATE public.app_settings
     SET value = jsonb_build_object('enabled', p_enabled, 'message', p_message, 'set_by', v_admin::text, 'set_at', NOW()),
         updated_at = NOW()
   WHERE key = 'master_kill_switch';

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'master_kill_switch_set', 'app_setting', NULL,
          jsonb_build_object('enabled', p_enabled, 'message', p_message, 'request_id', v_request_id));

  IF p_enabled THEN
    BEGIN
      PERFORM public.admin_cancel_all_active_jobs(true, 1, COALESCE('Master kill: ' || p_message, 'Master kill engaged'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object('enabled', p_enabled, 'message', p_message, 'request_id', v_request_id);
END;
$func$;

-- ── admin_grant_credits ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_grant_credits(p_target_user_id uuid, p_credits integer, p_reason text DEFAULT NULL::text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $func$
DECLARE
  caller_id    UUID := auth.uid();
  new_balance  INT;
  v_request_id uuid := gen_random_uuid();
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'admin_grant_credits: not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_super_admin(caller_id) THEN
    RAISE EXCEPTION 'admin_grant_credits: super_admin access required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.admin_rate_limit_check('grant_credits', 60);

  IF p_credits IS NULL OR p_credits = 0 THEN
    RAISE EXCEPTION 'admin_grant_credits: p_credits must be a non-zero integer' USING ERRCODE = '22023';
  END IF;

  -- Range guard unchanged.
  IF p_credits > 1000000 OR p_credits < -1000000 THEN
    RAISE EXCEPTION 'admin_grant_credits: amount out of range (-1000000..1000000)' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.user_credits (user_id, credits_balance, total_purchased)
  VALUES (
    p_target_user_id,
    GREATEST(p_credits, 0),
    GREATEST(p_credits, 0)
  )
  ON CONFLICT (user_id) DO UPDATE
    SET credits_balance = GREATEST(public.user_credits.credits_balance + p_credits, 0),
        total_purchased = public.user_credits.total_purchased + GREATEST(p_credits, 0),
        updated_at      = NOW()
  RETURNING credits_balance INTO new_balance;

  -- Audit row in admin_logs (separate from credit_transactions which
  -- is the user-visible history). Carries request_id for multi-step
  -- correlation.
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (caller_id, 'credits_granted', 'user', p_target_user_id,
          jsonb_build_object('amount', p_credits, 'reason', p_reason,
                             'new_balance', new_balance, 'request_id', v_request_id));

  -- credit_transactions audit (best-effort, schema may differ).
  BEGIN
    INSERT INTO public.credit_transactions (
      user_id, transaction_type, amount, description, created_at
    ) VALUES (
      p_target_user_id,
      CASE WHEN p_credits >= 0 THEN 'admin_grant' ELSE 'admin_adjustment' END,
      p_credits,
      COALESCE(p_reason, 'Admin credit grant'),
      NOW()
    );
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'credit_transactions audit insert skipped (schema mismatch)';
  END;

  RETURN new_balance;
END;
$func$;

-- ── admin_set_feature_flag ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_set_feature_flag(p_flag text, p_enabled boolean, p_reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE
  v_admin      uuid := auth.uid();
  v_old        boolean;
  v_request_id uuid := gen_random_uuid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_super_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_set_feature_flag: super_admin required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.admin_rate_limit_check('feature_flag_set', 60);

  SELECT enabled INTO v_old FROM public.feature_flags WHERE flag_name = p_flag;
  IF v_old IS NULL THEN
    INSERT INTO public.feature_flags (flag_name, enabled, description, updated_by)
    VALUES (p_flag, p_enabled, COALESCE(p_reason, ''), v_admin::text);
  ELSE
    UPDATE public.feature_flags
       SET enabled = p_enabled, updated_by = v_admin::text, updated_at = NOW()
     WHERE flag_name = p_flag;
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'feature_flag_set', 'feature_flag', NULL,
          jsonb_build_object('flag', p_flag, 'from', v_old, 'to', p_enabled,
                             'reason', p_reason, 'request_id', v_request_id));

  RETURN jsonb_build_object('flag', p_flag, 'enabled', p_enabled, 'request_id', v_request_id);
END;
$func$;

-- ── admin_update_flag_metadata ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_update_flag_metadata(p_flag text, p_description text, p_rollout_pct integer, p_audience jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE
  v_admin      uuid := auth.uid();
  v_request_id uuid := gen_random_uuid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_super_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_update_flag_metadata: super_admin required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.admin_rate_limit_check('flag_metadata', 60);

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
                             'rollout_pct', p_rollout_pct, 'audience', p_audience,
                             'request_id', v_request_id));
END;
$func$;

COMMIT;
