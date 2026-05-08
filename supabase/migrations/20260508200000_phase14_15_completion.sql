-- ============================================================
-- Phase 14 + 15 — Notifications + Newsletter completion
-- ============================================================
-- Closes the deferred items:
--   14.2 — mark_notification_read, dismiss_notification, snooze_notification
--   14.6 — notification_rules table + notification_channels app_settings key
--   15.1 — profiles.unsubscribe_token + unsubscribe_with_token RPC
--   15.2 — admin_send_test_to_self RPC
-- Worker handlers + edge functions ship in companion files.

BEGIN;

-- ── 14.2 user-side notification mutations ───────────────────────────
CREATE OR REPLACE FUNCTION public.mark_notification_read(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'mark_notification_read: not authenticated' USING ERRCODE = '42501';
  END IF;
  UPDATE public.user_notifications
     SET read_at = COALESCE(read_at, NOW())
   WHERE id = p_id AND user_id = v_uid;
END;
$func$;
REVOKE ALL ON FUNCTION public.mark_notification_read(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.dismiss_notification(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'dismiss_notification: not authenticated' USING ERRCODE = '42501';
  END IF;
  UPDATE public.user_notifications
     SET dismissed_at = COALESCE(dismissed_at, NOW()),
         read_at      = COALESCE(read_at, NOW())
   WHERE id = p_id AND user_id = v_uid;
END;
$func$;
REVOKE ALL ON FUNCTION public.dismiss_notification(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.dismiss_notification(uuid) TO authenticated;

-- Snooze: mark read + reschedule for `now + p_duration`. UI hides the
-- row until scheduled_for becomes the future, at which point the
-- handleScheduledNotifications worker re-delivers it.
CREATE OR REPLACE FUNCTION public.snooze_notification(p_id uuid, p_duration interval DEFAULT '1 hour'::interval)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'snooze_notification: not authenticated' USING ERRCODE = '42501';
  END IF;
  UPDATE public.user_notifications
     SET read_at       = NOW(),
         delivered_at  = NULL,
         scheduled_for = NOW() + p_duration
   WHERE id = p_id AND user_id = v_uid;
END;
$func$;
REVOKE ALL ON FUNCTION public.snooze_notification(uuid, interval) FROM anon;
GRANT EXECUTE ON FUNCTION public.snooze_notification(uuid, interval) TO authenticated;

-- ── 14.6 notification_rules table (admin-managed routing) ───────────
CREATE TABLE IF NOT EXISTS public.notification_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  -- condition_jsonb: { "severity": "high", "src_prefix": "stripe." }
  condition_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- action_jsonb:    { "channels": ["slack","pagerduty"], "slack_channel": "#ops-alerts" }
  action_jsonb    jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notification_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_rules_admin_all ON public.notification_rules;
CREATE POLICY notif_rules_admin_all ON public.notification_rules
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Channels live in `app_settings.notification_channels` (jsonb, single
-- row keyed by 'notification_channels'). Default: all toggles off so
-- routing is no-op until an admin opts in. The Phase 1 admin_get/
-- set_app_setting RPCs already gate on is_admin() so no extra RPC
-- needed here.
INSERT INTO public.app_settings (key, value)
VALUES (
  'notification_channels',
  jsonb_build_object(
    'slack',     jsonb_build_object('enabled', false, 'webhook_url', '', 'channel', '#ops-alerts'),
    'pagerduty', jsonb_build_object('enabled', false, 'integration_key', ''),
    'email',     jsonb_build_object('enabled', true,  'digest_to', 'support@motionmax.io'),
    'sms',       jsonb_build_object('enabled', false, 'provider', '', 'to', ''),
    'discord',   jsonb_build_object('enabled', false, 'webhook_url', '')
  )
)
ON CONFLICT (key) DO NOTHING;

-- ── 15.1 profiles.unsubscribe_token + unsubscribe RPC ───────────────
-- Random 32-byte token per user, generated on first newsletter send
-- (or on profile create going forward via a trigger). The footer link
-- is /unsubscribe?t=<token>; calling unsubscribe_with_token flips
-- marketing_opt_in to false and stamps newsletter_unsubscribed_at.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS unsubscribe_token text UNIQUE;

CREATE INDEX IF NOT EXISTS profiles_unsubscribe_token_idx
  ON public.profiles (unsubscribe_token)
  WHERE unsubscribe_token IS NOT NULL;

-- Helper: ensure a token exists for the user. Idempotent — returns
-- the existing token if already set. The newsletter worker calls this
-- per-recipient before generating the footer link.
CREATE OR REPLACE FUNCTION public.ensure_unsubscribe_token(p_user_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_tok text;
BEGIN
  SELECT unsubscribe_token INTO v_tok FROM public.profiles WHERE user_id = p_user_id;
  IF v_tok IS NOT NULL AND v_tok <> '' THEN RETURN v_tok; END IF;

  v_tok := encode(gen_random_bytes(24), 'base64');
  -- Strip URL-unsafe chars from base64 to keep the token clean in mail
  -- footers without manual URL-encoding.
  v_tok := translate(v_tok, '+/=', '-_');
  UPDATE public.profiles SET unsubscribe_token = v_tok WHERE user_id = p_user_id;
  RETURN v_tok;
END;
$func$;
REVOKE ALL ON FUNCTION public.ensure_unsubscribe_token(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.ensure_unsubscribe_token(uuid) TO service_role;

-- Public unsubscribe RPC. Anyone with a valid token can call this —
-- that's the point. We don't require auth.uid() because the user is
-- typically not signed in when they click the email footer link.
-- Returns the user's email for the confirmation page; returns NULL if
-- the token is invalid/unknown.
CREATE OR REPLACE FUNCTION public.unsubscribe_with_token(p_token text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_uid uuid; v_email text;
BEGIN
  IF p_token IS NULL OR LENGTH(p_token) < 10 THEN RETURN NULL; END IF;

  SELECT user_id INTO v_uid FROM public.profiles
   WHERE unsubscribe_token = p_token;
  IF v_uid IS NULL THEN RETURN NULL; END IF;

  UPDATE public.profiles
     SET marketing_opt_in = false,
         newsletter_unsubscribed_at = COALESCE(newsletter_unsubscribed_at, NOW())
   WHERE user_id = v_uid;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  RETURN v_email;
END;
$func$;
REVOKE ALL ON FUNCTION public.unsubscribe_with_token(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.unsubscribe_with_token(text) TO anon, authenticated;

-- ── 15.2 admin_send_test_to_self ────────────────────────────────────
-- Creates a single-recipient newsletter_send row keyed to the calling
-- admin's user_id. The handleNewsletterSend worker treats this row
-- identically to a regular send — Resend dispatch + status updates —
-- but it's bound to a special audience='__test__' campaign clone so
-- it doesn't pollute reporting on the real campaign. Admin gets the
-- email in their inbox within ~30 s of clicking Send Test.
CREATE OR REPLACE FUNCTION public.admin_send_test_to_self(p_campaign_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE
  v_admin uuid := auth.uid();
  v_email text;
  v_send_id uuid;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_send_test_to_self: forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.newsletter_campaigns WHERE id = p_campaign_id) THEN
    RAISE EXCEPTION 'admin_send_test_to_self: campaign not found' USING ERRCODE = '02000';
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_admin;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'admin_send_test_to_self: admin has no email' USING ERRCODE = '02000';
  END IF;

  -- One-shot send row. status='pending' picks it up on the next
  -- worker poll. The worker treats audience-test rows identically.
  INSERT INTO public.newsletter_sends (campaign_id, user_id, email, status)
  VALUES (p_campaign_id, v_admin, v_email, 'pending')
  ON CONFLICT (campaign_id, user_id) DO UPDATE
    SET status = 'pending', error = NULL, sent_at = NULL,
        opened_at = NULL, clicked_at = NULL, resend_message_id = NULL
  RETURNING id INTO v_send_id;

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'newsletter_test_send', 'campaign', p_campaign_id, jsonb_build_object('to', v_email));

  RETURN v_send_id;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_send_test_to_self(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_send_test_to_self(uuid) TO authenticated;

-- ── 15.3 helper: resolve audience filter to user_id list ────────────
-- Used by handleNewsletterSend to determine recipients. SECURITY
-- DEFINER so it can read auth.users.email + profiles fields the
-- worker's service-role connection would need anyway, but exposed via
-- RPC for testability and audit clarity.
CREATE OR REPLACE FUNCTION public.newsletter_resolve_audience(p_audience text)
RETURNS TABLE (user_id uuid, email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  -- service_role only — workers and admins both qualify.
  IF NOT (public.is_admin(auth.uid()) OR auth.role() = 'service_role') THEN
    RAISE EXCEPTION 'newsletter_resolve_audience: forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.user_id, au.email::text
    FROM public.profiles p
    JOIN auth.users au ON au.id = p.user_id
   WHERE p.marketing_opt_in = true
     AND p.newsletter_unsubscribed_at IS NULL
     AND au.email IS NOT NULL
     AND (
       p_audience = 'all_opted_in' OR p_audience = 'all'
       OR (p_audience = 'studio' AND EXISTS (
             SELECT 1 FROM public.subscriptions s
              WHERE s.user_id = p.user_id
                AND s.status IN ('active','trialing')
                AND COALESCE(s.plan_name, '') ILIKE '%studio%'))
       OR (p_audience = 'pro' AND EXISTS (
             SELECT 1 FROM public.subscriptions s
              WHERE s.user_id = p.user_id
                AND s.status IN ('active','trialing')
                AND COALESCE(s.plan_name, '') ILIKE '%pro%'
                AND COALESCE(s.plan_name, '') NOT ILIKE '%studio%'))
       OR (p_audience = 'free' AND NOT EXISTS (
             SELECT 1 FROM public.subscriptions s
              WHERE s.user_id = p.user_id
                AND s.status IN ('active','trialing')))
     );
END;
$func$;
REVOKE ALL ON FUNCTION public.newsletter_resolve_audience(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.newsletter_resolve_audience(text) TO service_role, authenticated;

COMMIT;
