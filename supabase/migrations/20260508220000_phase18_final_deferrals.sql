-- ============================================================
-- Phase 13.5 + 14.6 + 15.8 final deferral schema
-- ============================================================
--   13.5 — admin_message_threads.csat_score / csat_at / csat_comment
--          + submit_csat_feedback(p_token text, p_score int, p_comment text)
--          anon-callable RPC
--          + admin_messages_kpis updated to include sat_score_30d
--   14.6 — notification_rules already exists (Phase 17 migration);
--          add app_settings RPC convenience reads
--   15.8 — admin_campaign_detail(p_campaign_id) RPC for the drawer
--   15.8 — admin_clone_campaign(p_campaign_id) RPC

BEGIN;

-- ── 13.5 thread CSAT ───────────────────────────────────────────────
ALTER TABLE public.admin_message_threads
  ADD COLUMN IF NOT EXISTS csat_score   int CHECK (csat_score BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS csat_at      timestamptz,
  ADD COLUMN IF NOT EXISTS csat_comment text,
  -- HMAC-friendly per-thread token used in the closing-thread email.
  -- Generated lazily by ensure_csat_token() the first time a closing
  -- email is rendered, mirroring the unsubscribe_token pattern.
  ADD COLUMN IF NOT EXISTS csat_token   text UNIQUE;

CREATE INDEX IF NOT EXISTS admin_message_threads_csat_at_idx
  ON public.admin_message_threads (csat_at DESC)
  WHERE csat_at IS NOT NULL;

-- Idempotent token issuer — admin / worker side.
CREATE OR REPLACE FUNCTION public.ensure_csat_token(p_thread_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_tok text;
BEGIN
  SELECT csat_token INTO v_tok FROM public.admin_message_threads WHERE id = p_thread_id;
  IF v_tok IS NOT NULL AND v_tok <> '' THEN RETURN v_tok; END IF;

  v_tok := translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');
  UPDATE public.admin_message_threads SET csat_token = v_tok WHERE id = p_thread_id;
  RETURN v_tok;
END;
$func$;
REVOKE ALL ON FUNCTION public.ensure_csat_token(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_csat_token(uuid) TO service_role;

-- Anon-callable submit (the user clicks an emoji in the closing
-- email — they're typically not signed in). Idempotent: re-clicking
-- with a new score updates in place; comment is appended only when
-- non-empty so a follow-up rating doesn't blank an earlier comment.
CREATE OR REPLACE FUNCTION public.submit_csat_feedback(
  p_token   text,
  p_score   int,
  p_comment text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v_thread uuid;
BEGIN
  IF p_score IS NULL OR p_score < 1 OR p_score > 5 THEN
    RAISE EXCEPTION 'submit_csat_feedback: score must be 1..5' USING ERRCODE = '22023';
  END IF;
  IF p_token IS NULL OR LENGTH(p_token) < 10 THEN RETURN false; END IF;

  SELECT id INTO v_thread FROM public.admin_message_threads
   WHERE csat_token = p_token;
  IF v_thread IS NULL THEN RETURN false; END IF;

  UPDATE public.admin_message_threads
     SET csat_score   = p_score,
         csat_at      = NOW(),
         csat_comment = COALESCE(NULLIF(TRIM(p_comment), ''), csat_comment)
   WHERE id = v_thread;
  RETURN true;
END;
$func$;
REVOKE ALL ON FUNCTION public.submit_csat_feedback(text, int, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.submit_csat_feedback(text, int, text) TO anon, authenticated;

-- Patch admin_messages_kpis to include sat_score_30d.
CREATE OR REPLACE FUNCTION public.admin_messages_kpis()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_messages_kpis: forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'open_threads', (
      SELECT COUNT(*) FROM public.admin_message_threads
       WHERE status IN ('open','answered')
    ),
    'unread', (
      SELECT COUNT(*) FROM public.admin_messages m
       JOIN public.admin_message_threads t ON t.id = m.thread_id
       WHERE m.sender_role = 'user' AND m.read_at IS NULL
    ),
    'avg_first_reply_min', (
      SELECT EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY first_admin - thread_open))::numeric / 60.0
        FROM (
          SELECT t.created_at AS thread_open,
                 (SELECT MIN(m.created_at) FROM public.admin_messages m
                   WHERE m.thread_id = t.id AND m.sender_role = 'admin') AS first_admin
            FROM public.admin_message_threads t
           WHERE t.created_at > NOW() - INTERVAL '30 days'
        ) firsts
       WHERE first_admin IS NOT NULL
    ),
    'closed_30d', (
      SELECT COUNT(*) FROM public.admin_message_threads
       WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '30 days'
    ),
    'sat_score_30d', (
      SELECT ROUND(AVG(csat_score)::numeric, 2)
        FROM public.admin_message_threads
       WHERE csat_at > NOW() - INTERVAL '30 days'
    ),
    'sat_response_count_30d', (
      SELECT COUNT(*) FROM public.admin_message_threads
       WHERE csat_at > NOW() - INTERVAL '30 days'
    )
  ) INTO v;
  RETURN v;
END;
$func$;

-- ── 15.8 campaign detail + clone ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_campaign_detail(p_campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE v jsonb;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_campaign_detail: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'campaign', to_jsonb(c),
    'totals', jsonb_build_object(
      'recipients', (SELECT COUNT(*) FROM public.newsletter_sends s WHERE s.campaign_id = c.id),
      'sent',       (SELECT COUNT(*) FROM public.newsletter_sends s WHERE s.campaign_id = c.id AND s.status IN ('sent','opened','clicked')),
      'pending',    (SELECT COUNT(*) FROM public.newsletter_sends s WHERE s.campaign_id = c.id AND s.status = 'pending'),
      'failed',     (SELECT COUNT(*) FROM public.newsletter_sends s WHERE s.campaign_id = c.id AND s.status = 'failed'),
      'opened',     (SELECT COUNT(*) FROM public.newsletter_sends s WHERE s.campaign_id = c.id AND s.opened_at IS NOT NULL),
      'clicked',    (SELECT COUNT(*) FROM public.newsletter_sends s WHERE s.campaign_id = c.id AND s.clicked_at IS NOT NULL),
      'bounced',    (SELECT COUNT(*) FROM public.newsletter_sends s WHERE s.campaign_id = c.id AND s.status = 'bounced'),
      'complained', (SELECT COUNT(*) FROM public.newsletter_sends s WHERE s.campaign_id = c.id AND s.status = 'complained')
    ),
    'recent_failures', COALESCE((
      SELECT jsonb_agg(to_jsonb(s))
        FROM (
          SELECT email, status, error
            FROM public.newsletter_sends s
           WHERE s.campaign_id = c.id AND s.status IN ('failed','bounced','complained')
           ORDER BY s.id DESC LIMIT 10
        ) s
    ), '[]'::jsonb)
  ) INTO v
  FROM public.newsletter_campaigns c
  WHERE c.id = p_campaign_id;

  IF v IS NULL THEN
    RAISE EXCEPTION 'admin_campaign_detail: campaign % not found', p_campaign_id USING ERRCODE = '02000';
  END IF;
  RETURN v;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_campaign_detail(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_campaign_detail(uuid) TO authenticated;

-- Clone — duplicates a campaign as a new draft (status='draft',
-- no schedule, no sends). Useful for re-running a campaign with a
-- tweaked subject line.
CREATE OR REPLACE FUNCTION public.admin_clone_campaign(p_campaign_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE
  v_admin uuid := auth.uid();
  v_new   uuid;
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_clone_campaign: forbidden' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.newsletter_campaigns (
    subject, body_html, body_text, audience, status, created_by
  )
  SELECT
    'Copy: ' || subject,
    body_html, body_text, audience, 'draft', v_admin
    FROM public.newsletter_campaigns
   WHERE id = p_campaign_id
  RETURNING id INTO v_new;
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'admin_clone_campaign: source campaign not found' USING ERRCODE = '02000';
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (v_admin, 'campaign_cloned', 'campaign', v_new, jsonb_build_object('source_id', p_campaign_id));
  RETURN v_new;
END;
$func$;
REVOKE ALL ON FUNCTION public.admin_clone_campaign(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_clone_campaign(uuid) TO authenticated;

COMMIT;
