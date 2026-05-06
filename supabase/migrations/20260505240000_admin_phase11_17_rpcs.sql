-- ============================================================
-- Admin rebuild — Phases 11 (Errors), 12 (Console), 13 (Messages),
--                 14 (Notifications), 15 (Newsletter),
--                 16 (Announcements), 17 (Kill switches)
-- ============================================================
-- All RPCs SECURITY DEFINER, gated on is_admin(auth.uid()).
-- ============================================================

BEGIN;

-- ============================================================
-- Phase 11: Errors
-- ============================================================

-- 1. admin_errors_kpis()
CREATE OR REPLACE FUNCTION public.admin_errors_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'admin_errors_kpis: forbidden' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object(
    'errors_1h',           (SELECT COUNT(*) FROM public.system_logs WHERE category = 'system_error' AND created_at > NOW() - INTERVAL '1 hour'),
    'errors_peak_24h',     (SELECT COALESCE(MAX(c), 0) FROM (SELECT date_trunc('hour', created_at) AS hr, COUNT(*) AS c FROM public.system_logs WHERE category = 'system_error' AND created_at > NOW() - INTERVAL '24 hours' GROUP BY 1) hourly),
    'affected_users_1h',   (SELECT COUNT(DISTINCT user_id) FROM public.system_logs WHERE category = 'system_error' AND user_id IS NOT NULL AND created_at > NOW() - INTERVAL '1 hour'),
    'open_signatures',     (SELECT COUNT(DISTINCT fingerprint) FROM public.system_logs WHERE category = 'system_error' AND fingerprint IS NOT NULL AND resolved_at IS NULL AND created_at > NOW() - INTERVAL '7 days')
  ) INTO v; RETURN v;
END; $func$;
REVOKE ALL ON FUNCTION public.admin_errors_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_errors_kpis() TO authenticated;

-- 2. admin_error_groups(p_since, p_limit) — group system_error rows by fingerprint
CREATE OR REPLACE FUNCTION public.admin_error_groups(
  p_since timestamptz DEFAULT NOW() - INTERVAL '24 hours',
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  fingerprint text,
  event_type text,
  events bigint,
  users bigint,
  first_seen timestamptz,
  last_seen timestamptz,
  sample_message text,
  sample_details jsonb,
  resolved boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'admin_error_groups: forbidden' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT
    COALESCE(sl.fingerprint, sl.event_type) AS fingerprint,
    MAX(sl.event_type) AS event_type,
    COUNT(*)::bigint AS events,
    COUNT(DISTINCT sl.user_id)::bigint AS users,
    MIN(sl.created_at) AS first_seen,
    MAX(sl.created_at) AS last_seen,
    (ARRAY_AGG(sl.message ORDER BY sl.created_at DESC))[1] AS sample_message,
    (ARRAY_AGG(sl.details ORDER BY sl.created_at DESC))[1] AS sample_details,
    BOOL_AND(sl.resolved_at IS NOT NULL) AS resolved
  FROM public.system_logs sl
  WHERE sl.category = 'system_error'
    AND sl.created_at >= p_since
  GROUP BY 1
  ORDER BY events DESC
  LIMIT p_limit;
END; $func$;
REVOKE ALL ON FUNCTION public.admin_error_groups(timestamptz, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_error_groups(timestamptz, int) TO authenticated;

-- 3. admin_resolve_error_group(p_fingerprint, p_notes) — bulk-mark resolved
CREATE OR REPLACE FUNCTION public.admin_resolve_error_group(p_fingerprint text, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_count int;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_resolve_error_group: forbidden' USING ERRCODE = '42501'; END IF;
  UPDATE public.system_logs
     SET resolved_at = NOW(), resolved_by = v_admin
   WHERE category = 'system_error'
     AND COALESCE(fingerprint, event_type) = p_fingerprint
     AND resolved_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'error_group_resolved', 'error_fingerprint', NULL, jsonb_build_object('fingerprint', p_fingerprint, 'rows_affected', v_count, 'notes', p_notes));
  RETURN jsonb_build_object('fingerprint', p_fingerprint, 'rows_affected', v_count);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_resolve_error_group(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_error_group(text, text) TO authenticated;

-- 4. admin_errors_by_surface() — for the cols-3 cards
CREATE OR REPLACE FUNCTION public.admin_errors_by_surface()
RETURNS TABLE (surface text, events bigint, daily_counts int[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'admin_errors_by_surface: forbidden' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT
    CASE
      WHEN COALESCE(sl.event_type, '') ILIKE 'worker.%' OR sl.worker_id IS NOT NULL THEN 'Worker'
      WHEN COALESCE(sl.event_type, '') ILIKE 'edge.%' OR COALESCE(sl.event_type, '') ILIKE 'stripe.%' THEN 'Edge functions'
      ELSE 'Web app'
    END::text AS surface,
    COUNT(*)::bigint AS events,
    ARRAY(
      SELECT COUNT(*)::int
      FROM generate_series(0, 13) i
      LEFT JOIN public.system_logs sl2 ON sl2.category = 'system_error'
        AND sl2.created_at::date = (CURRENT_DATE - i)::date
      GROUP BY i ORDER BY i DESC
    )
  FROM public.system_logs sl
  WHERE sl.category = 'system_error'
    AND sl.created_at > NOW() - INTERVAL '7 days'
  GROUP BY 1
  ORDER BY 2 DESC;
END; $func$;
REVOKE ALL ON FUNCTION public.admin_errors_by_surface() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_errors_by_surface() TO authenticated;


-- ============================================================
-- Phase 13: Messages
-- ============================================================

-- 5. admin_messages_kpis()
CREATE OR REPLACE FUNCTION public.admin_messages_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'admin_messages_kpis: forbidden' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object(
    'open_threads',    (SELECT COUNT(*) FROM public.admin_message_threads WHERE status IN ('open','answered')),
    'unread',          (SELECT COUNT(*) FROM public.admin_messages WHERE sender_role = 'user' AND read_at IS NULL),
    'avg_first_reply_min', 0,  -- placeholder until we track first_reply_at
    'closed_30d',      (SELECT COUNT(*) FROM public.admin_message_threads WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '30 days')
  ) INTO v; RETURN v;
END; $func$;
REVOKE ALL ON FUNCTION public.admin_messages_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_messages_kpis() TO authenticated;

-- 6. admin_open_thread(p_user_id, p_subject, p_body) — admin starts a thread
CREATE OR REPLACE FUNCTION public.admin_open_thread(p_user_id uuid, p_subject text, p_body text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_thread_id uuid;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_open_thread: forbidden' USING ERRCODE = '42501'; END IF;
  IF p_subject IS NULL OR length(trim(p_subject)) = 0 THEN RAISE EXCEPTION 'subject required' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.admin_message_threads (user_id, subject, status)
  VALUES (p_user_id, trim(p_subject), 'open') RETURNING id INTO v_thread_id;
  INSERT INTO public.admin_messages (thread_id, sender_id, sender_role, body)
  VALUES (v_thread_id, v_admin, 'admin', p_body);
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'thread_opened', 'admin_message_thread', v_thread_id, jsonb_build_object('user_id', p_user_id, 'subject', p_subject));
  RETURN jsonb_build_object('thread_id', v_thread_id);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_open_thread(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_open_thread(uuid, text, text) TO authenticated;

-- 7. admin_post_reply(p_thread_id, p_body)
CREATE OR REPLACE FUNCTION public.admin_post_reply(p_thread_id uuid, p_body text, p_attachments jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_msg_id uuid;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_post_reply: forbidden' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.admin_messages (thread_id, sender_id, sender_role, body, attachments)
  VALUES (p_thread_id, v_admin, 'admin', p_body, COALESCE(p_attachments, '[]'::jsonb)) RETURNING id INTO v_msg_id;
  UPDATE public.admin_message_threads SET status = 'answered', last_message_at = NOW() WHERE id = p_thread_id;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'thread_replied', 'admin_message_thread', p_thread_id, jsonb_build_object('message_id', v_msg_id));
  RETURN jsonb_build_object('message_id', v_msg_id);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_post_reply(uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_post_reply(uuid, text, jsonb) TO authenticated;

-- 8. admin_close_thread(p_thread_id, p_notes)
CREATE OR REPLACE FUNCTION public.admin_close_thread(p_thread_id uuid, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_close_thread: forbidden' USING ERRCODE = '42501'; END IF;
  UPDATE public.admin_message_threads SET status = 'closed', closed_at = NOW(), closed_by = v_admin WHERE id = p_thread_id;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'thread_closed', 'admin_message_thread', p_thread_id, jsonb_build_object('notes', p_notes));
  RETURN jsonb_build_object('thread_id', p_thread_id, 'status', 'closed');
END; $func$;
REVOKE ALL ON FUNCTION public.admin_close_thread(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_close_thread(uuid, text) TO authenticated;

-- 9. admin_mark_message_read(p_message_id)
CREATE OR REPLACE FUNCTION public.admin_mark_message_read(p_message_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'admin_mark_message_read: forbidden' USING ERRCODE = '42501'; END IF;
  UPDATE public.admin_messages SET read_at = NOW() WHERE id = p_message_id AND read_at IS NULL;
  RETURN jsonb_build_object('message_id', p_message_id, 'read_at', NOW());
END; $func$;
REVOKE ALL ON FUNCTION public.admin_mark_message_read(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_message_read(uuid) TO authenticated;


-- ============================================================
-- Phase 14: Notifications
-- ============================================================

-- 10. admin_notifications_kpis()
CREATE OR REPLACE FUNCTION public.admin_notifications_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'admin_notifications_kpis: forbidden' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object(
    'unread_alerts',  (SELECT COUNT(*) FROM public.user_notifications WHERE sent_by_admin_id IS NOT NULL AND read_at IS NULL),
    'sent_24h',       (SELECT COUNT(*) FROM public.user_notifications WHERE sent_by_admin_id IS NOT NULL AND created_at > NOW() - INTERVAL '24 hours'),
    'scheduled',      (SELECT COUNT(*) FROM public.user_notifications WHERE scheduled_for IS NOT NULL AND delivered_at IS NULL),
    'severity_high',  (SELECT COUNT(*) FROM public.user_notifications WHERE severity = 'error' AND created_at > NOW() - INTERVAL '7 days')
  ) INTO v; RETURN v;
END; $func$;
REVOKE ALL ON FUNCTION public.admin_notifications_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_notifications_kpis() TO authenticated;

-- 11. admin_send_notification(p_user_ids[], p_title, p_body, p_cta_url, p_severity)
CREATE OR REPLACE FUNCTION public.admin_send_notification(
  p_user_ids uuid[],
  p_title text,
  p_body text,
  p_cta_url text DEFAULT NULL,
  p_severity text DEFAULT 'info'
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_count int := 0; v_uid uuid;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_send_notification: forbidden' USING ERRCODE = '42501'; END IF;
  IF p_severity NOT IN ('info','success','warn','error') THEN RAISE EXCEPTION 'invalid severity' USING ERRCODE = '22023'; END IF;
  FOREACH v_uid IN ARRAY p_user_ids LOOP
    INSERT INTO public.user_notifications (user_id, title, body, cta_url, severity, delivered_at, sent_by_admin_id)
    VALUES (v_uid, p_title, p_body, p_cta_url, p_severity, NOW(), v_admin);
    v_count := v_count + 1;
  END LOOP;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'notification_sent', 'user_set', NULL, jsonb_build_object('count', v_count, 'severity', p_severity, 'title', p_title));
  RETURN jsonb_build_object('sent', v_count);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_send_notification(uuid[], text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_send_notification(uuid[], text, text, text, text) TO authenticated;

-- 12. admin_send_notification_to_segment
CREATE OR REPLACE FUNCTION public.admin_send_notification_to_segment(
  p_segment text,
  p_title text,
  p_body text,
  p_cta_url text DEFAULT NULL,
  p_severity text DEFAULT 'info'
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_user_ids uuid[];
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_send_notification_to_segment: forbidden' USING ERRCODE = '42501'; END IF;
  IF p_segment = 'all' THEN
    SELECT ARRAY_AGG(p.user_id) INTO v_user_ids FROM public.profiles p WHERE p.deleted_at IS NULL;
  ELSIF p_segment LIKE 'plan:%' THEN
    SELECT ARRAY_AGG(s.user_id) INTO v_user_ids FROM public.subscriptions s
    WHERE s.status IN ('active','trialing') AND COALESCE(s.plan_name, '') ILIKE '%' || split_part(p_segment, ':', 2) || '%';
  ELSIF p_segment = 'active_7d' THEN
    SELECT ARRAY_AGG(DISTINCT user_id) INTO v_user_ids FROM public.system_logs WHERE category = 'user_activity' AND created_at > NOW() - INTERVAL '7 days';
  ELSE
    RAISE EXCEPTION 'unknown segment %', p_segment USING ERRCODE = '22023';
  END IF;
  IF v_user_ids IS NULL OR array_length(v_user_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('sent', 0);
  END IF;
  RETURN public.admin_send_notification(v_user_ids, p_title, p_body, p_cta_url, p_severity);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_send_notification_to_segment(text, text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_send_notification_to_segment(text, text, text, text, text) TO authenticated;

-- 13. admin_schedule_notification — fire later
CREATE OR REPLACE FUNCTION public.admin_schedule_notification(
  p_user_ids uuid[],
  p_title text,
  p_body text,
  p_scheduled_for timestamptz,
  p_cta_url text DEFAULT NULL,
  p_severity text DEFAULT 'info'
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_count int := 0; v_uid uuid;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_schedule_notification: forbidden' USING ERRCODE = '42501'; END IF;
  IF p_scheduled_for <= NOW() THEN RAISE EXCEPTION 'scheduled_for must be future' USING ERRCODE = '22023'; END IF;
  FOREACH v_uid IN ARRAY p_user_ids LOOP
    INSERT INTO public.user_notifications (user_id, title, body, cta_url, severity, scheduled_for, sent_by_admin_id)
    VALUES (v_uid, p_title, p_body, p_cta_url, p_severity, p_scheduled_for, v_admin);
    v_count := v_count + 1;
  END LOOP;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'notification_scheduled', 'user_set', NULL, jsonb_build_object('count', v_count, 'scheduled_for', p_scheduled_for, 'title', p_title));
  RETURN jsonb_build_object('scheduled', v_count, 'scheduled_for', p_scheduled_for);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_schedule_notification(uuid[], text, text, timestamptz, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_schedule_notification(uuid[], text, text, timestamptz, text, text) TO authenticated;


-- ============================================================
-- Phase 15: Newsletter
-- ============================================================

-- 14. admin_newsletter_kpis()
CREATE OR REPLACE FUNCTION public.admin_newsletter_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'admin_newsletter_kpis: forbidden' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object(
    'subscribers',          (SELECT COUNT(*) FROM public.profiles WHERE marketing_opt_in = true AND deleted_at IS NULL),
    'subscribers_delta_7d', (SELECT COUNT(*) FROM public.profiles WHERE marketing_opt_in = true AND created_at > NOW() - INTERVAL '7 days'),
    'last_send_open_pct',   (SELECT CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::numeric / COUNT(*)::numeric * 100, 1) ELSE 0 END FROM public.newsletter_sends WHERE campaign_id = (SELECT id FROM public.newsletter_campaigns WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1)),
    'last_send_click_pct',  (SELECT CASE WHEN COUNT(*) > 0 THEN ROUND(COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::numeric / COUNT(*)::numeric * 100, 1) ELSE 0 END FROM public.newsletter_sends WHERE campaign_id = (SELECT id FROM public.newsletter_campaigns WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1)),
    'last_send_unsubs',     (SELECT COUNT(*) FROM public.profiles WHERE newsletter_unsubscribed_at > (SELECT sent_at FROM public.newsletter_campaigns WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1))
  ) INTO v; RETURN v;
END; $func$;
REVOKE ALL ON FUNCTION public.admin_newsletter_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_newsletter_kpis() TO authenticated;

-- 15. admin_create_campaign
CREATE OR REPLACE FUNCTION public.admin_create_campaign(
  p_subject text,
  p_body_html text,
  p_body_text text DEFAULT NULL,
  p_audience text DEFAULT 'all_opted_in'
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_create_campaign: forbidden' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.newsletter_campaigns (subject, body_html, body_text, audience, status, created_by)
  VALUES (p_subject, p_body_html, p_body_text, p_audience, 'draft', v_admin) RETURNING id INTO v_id;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'campaign_created', 'newsletter_campaign', v_id, jsonb_build_object('subject', p_subject, 'audience', p_audience));
  RETURN jsonb_build_object('id', v_id, 'status', 'draft');
END; $func$;
REVOKE ALL ON FUNCTION public.admin_create_campaign(text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_create_campaign(text, text, text, text) TO authenticated;

-- 16. admin_schedule_campaign
CREATE OR REPLACE FUNCTION public.admin_schedule_campaign(p_id uuid, p_scheduled_for timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_schedule_campaign: forbidden' USING ERRCODE = '42501'; END IF;
  UPDATE public.newsletter_campaigns SET status = 'scheduled', scheduled_for = p_scheduled_for, updated_at = NOW() WHERE id = p_id AND status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign not in draft state' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'campaign_scheduled', 'newsletter_campaign', p_id, jsonb_build_object('scheduled_for', p_scheduled_for));
  RETURN jsonb_build_object('id', p_id, 'status', 'scheduled', 'scheduled_for', p_scheduled_for);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_schedule_campaign(uuid, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_schedule_campaign(uuid, timestamptz) TO authenticated;

-- 17. admin_cancel_campaign
CREATE OR REPLACE FUNCTION public.admin_cancel_campaign(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_cancel_campaign: forbidden' USING ERRCODE = '42501'; END IF;
  UPDATE public.newsletter_campaigns SET status = 'cancelled', updated_at = NOW() WHERE id = p_id AND status IN ('draft','scheduled','sending');
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign cannot be cancelled' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'campaign_cancelled', 'newsletter_campaign', p_id, '{}'::jsonb);
  RETURN jsonb_build_object('id', p_id, 'status', 'cancelled');
END; $func$;
REVOKE ALL ON FUNCTION public.admin_cancel_campaign(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_cancel_campaign(uuid) TO authenticated;


-- ============================================================
-- Phase 16: Announcements
-- ============================================================

-- 18. admin_announcements_kpis()
CREATE OR REPLACE FUNCTION public.admin_announcements_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'admin_announcements_kpis: forbidden' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object(
    'active',         (SELECT COUNT(*) FROM public.announcements WHERE active AND now() >= starts_at AND (ends_at IS NULL OR now() <= ends_at)),
    'created_7d',     (SELECT COUNT(*) FROM public.announcements WHERE created_at > NOW() - INTERVAL '7 days'),
    'dismissed_24h',  (SELECT COUNT(*) FROM public.announcement_dismissals WHERE dismissed_at > NOW() - INTERVAL '24 hours'),
    'critical_open',  (SELECT COUNT(*) FROM public.announcements WHERE active AND severity = 'critical' AND now() >= starts_at AND (ends_at IS NULL OR now() <= ends_at))
  ) INTO v; RETURN v;
END; $func$;
REVOKE ALL ON FUNCTION public.admin_announcements_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_announcements_kpis() TO authenticated;

-- 19. admin_create_announcement
CREATE OR REPLACE FUNCTION public.admin_create_announcement(
  p_title text,
  p_body_md text,
  p_severity text DEFAULT 'info',
  p_cta_label text DEFAULT NULL,
  p_cta_url text DEFAULT NULL,
  p_audience jsonb DEFAULT '{"plan":"all"}'::jsonb,
  p_starts_at timestamptz DEFAULT NOW(),
  p_ends_at timestamptz DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_create_announcement: forbidden' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.announcements (title, body_md, severity, cta_label, cta_url, audience, starts_at, ends_at, created_by)
  VALUES (p_title, p_body_md, p_severity, p_cta_label, p_cta_url, p_audience, p_starts_at, p_ends_at, v_admin)
  RETURNING id INTO v_id;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'announcement_created', 'announcement', v_id, jsonb_build_object('title', p_title, 'severity', p_severity));
  RETURN jsonb_build_object('id', v_id);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_create_announcement(text, text, text, text, text, jsonb, timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_create_announcement(text, text, text, text, text, jsonb, timestamptz, timestamptz) TO authenticated;

-- 20. admin_archive_announcement
CREATE OR REPLACE FUNCTION public.admin_archive_announcement(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_archive_announcement: forbidden' USING ERRCODE = '42501'; END IF;
  UPDATE public.announcements SET active = false, ends_at = LEAST(COALESCE(ends_at, NOW()), NOW()), updated_at = NOW() WHERE id = p_id;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'announcement_archived', 'announcement', p_id, '{}'::jsonb);
  RETURN jsonb_build_object('id', p_id, 'archived', true);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_archive_announcement(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_archive_announcement(uuid) TO authenticated;

-- 21. current_announcements_for_me — for end users
CREATE OR REPLACE FUNCTION public.current_announcements_for_me()
RETURNS SETOF public.announcements
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT a.* FROM public.announcements a
  WHERE a.active
    AND now() >= a.starts_at
    AND (a.ends_at IS NULL OR now() <= a.ends_at)
    AND NOT EXISTS (
      SELECT 1 FROM public.announcement_dismissals d
      WHERE d.announcement_id = a.id AND d.user_id = auth.uid()
    )
  ORDER BY
    CASE a.severity WHEN 'critical' THEN 1 WHEN 'warn' THEN 2 WHEN 'feature' THEN 3 ELSE 4 END,
    a.created_at DESC;
END; $func$;
REVOKE ALL ON FUNCTION public.current_announcements_for_me() FROM anon;
GRANT EXECUTE ON FUNCTION public.current_announcements_for_me() TO authenticated;

-- 22. dismiss_announcement
CREATE OR REPLACE FUNCTION public.dismiss_announcement(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'dismiss_announcement: not authenticated' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.announcement_dismissals (announcement_id, user_id) VALUES (p_id, auth.uid()) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('id', p_id, 'dismissed', true);
END; $func$;
REVOKE ALL ON FUNCTION public.dismiss_announcement(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.dismiss_announcement(uuid) TO authenticated;


-- ============================================================
-- Phase 17: Kill switches
-- ============================================================

-- Seed master_kill_switch row (idempotent)
INSERT INTO public.app_settings (key, value)
VALUES ('master_kill_switch', jsonb_build_object('enabled', false, 'message', null, 'set_by', null, 'set_at', null))
ON CONFLICT (key) DO NOTHING;

-- 23. admin_kill_switches_kpis()
CREATE OR REPLACE FUNCTION public.admin_kill_switches_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'admin_kill_switches_kpis: forbidden' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object(
    'master_engaged',  COALESCE((SELECT (value->>'enabled')::boolean FROM public.app_settings WHERE key = 'master_kill_switch'), false),
    'flags_total',     (SELECT COUNT(*) FROM public.feature_flags),
    'flags_disabled',  (SELECT COUNT(*) FROM public.feature_flags WHERE enabled = false),
    'last_flag_flip',  (SELECT MAX(updated_at) FROM public.feature_flags)
  ) INTO v; RETURN v;
END; $func$;
REVOKE ALL ON FUNCTION public.admin_kill_switches_kpis() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_kill_switches_kpis() TO authenticated;

-- 24. admin_set_feature_flag
CREATE OR REPLACE FUNCTION public.admin_set_feature_flag(p_flag text, p_enabled boolean, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid(); v_old boolean;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_set_feature_flag: forbidden' USING ERRCODE = '42501'; END IF;
  SELECT enabled INTO v_old FROM public.feature_flags WHERE flag_name = p_flag;
  IF v_old IS NULL THEN
    INSERT INTO public.feature_flags (flag_name, enabled, description, updated_by) VALUES (p_flag, p_enabled, COALESCE(p_reason, ''), v_admin::text);
  ELSE
    UPDATE public.feature_flags SET enabled = p_enabled, updated_by = v_admin::text, updated_at = NOW() WHERE flag_name = p_flag;
  END IF;
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'feature_flag_set', 'feature_flag', NULL, jsonb_build_object('flag', p_flag, 'from', v_old, 'to', p_enabled, 'reason', p_reason));
  RETURN jsonb_build_object('flag', p_flag, 'enabled', p_enabled);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_set_feature_flag(text, boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_feature_flag(text, boolean, text) TO authenticated;

-- 25. admin_set_master_kill_switch
CREATE OR REPLACE FUNCTION public.admin_set_master_kill_switch(p_enabled boolean, p_message text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_admin uuid := auth.uid();
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN RAISE EXCEPTION 'admin_set_master_kill_switch: forbidden' USING ERRCODE = '42501'; END IF;
  UPDATE public.app_settings
     SET value = jsonb_build_object(
       'enabled', p_enabled,
       'message', p_message,
       'set_by', v_admin::text,
       'set_at', NOW()
     ),
     updated_at = NOW()
   WHERE key = 'master_kill_switch';
  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'master_kill_switch_set', 'app_setting', NULL, jsonb_build_object('enabled', p_enabled, 'message', p_message));
  -- Side-effect: when transitioning to engaged, cancel all active jobs.
  IF p_enabled THEN
    BEGIN
      PERFORM public.admin_cancel_all_active_jobs(true, 1, COALESCE('Master kill: ' || p_message, 'Master kill engaged'));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
  RETURN jsonb_build_object('enabled', p_enabled, 'message', p_message);
END; $func$;
REVOKE ALL ON FUNCTION public.admin_set_master_kill_switch(boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_master_kill_switch(boolean, text) TO authenticated;

-- 26. admin_feature_flags_list — convenience read
CREATE OR REPLACE FUNCTION public.admin_feature_flags_list()
RETURNS TABLE (flag_name text, enabled boolean, description text, updated_at timestamptz, updated_by text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN RAISE EXCEPTION 'admin_feature_flags_list: forbidden' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT f.flag_name, f.enabled, f.description, f.updated_at, f.updated_by FROM public.feature_flags f ORDER BY f.flag_name;
END; $func$;
REVOKE ALL ON FUNCTION public.admin_feature_flags_list() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_feature_flags_list() TO authenticated;

COMMIT;
