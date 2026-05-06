-- ============================================================
-- Support tickets — backend for the Help & Support contact form.
--
-- Adds:
--   - public.support_tickets (table + RLS + index + updated_at trigger)
--   - public.admin_update_ticket_status(...)  admin-gated write RPC
--   - public.admin_list_support_tickets(...)  admin-gated read RPC
--   - public.support_system_status()          public read RPC for the
--     Help page status panel — derives operational/degraded/down state
--     from existing tables (video_generation_jobs, system_logs,
--     generations, webhook_events).
--
-- The submit-support-ticket edge fn inserts via service-role; the user
-- INSERT policy below is a defence-in-depth fallback so a future client
-- write path stays scoped to `auth.uid() = user_id`.
-- ============================================================

BEGIN;

-- ── 1. support_tickets table ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id           UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  email        TEXT NOT NULL,
  name         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  topic        TEXT NOT NULL CHECK (topic IN ('billing','render','voice','account','api','other')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_to  UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  admin_notes  TEXT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin queue index — status-first, newest first.
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_created
  ON public.support_tickets (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id
  ON public.support_tickets (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets FORCE ROW LEVEL SECURITY;

-- ── 2. RLS policies ──────────────────────────────────────────
-- Users SELECT their own tickets.
DROP POLICY IF EXISTS "support_tickets_user_select" ON public.support_tickets;
CREATE POLICY "support_tickets_user_select"
  ON public.support_tickets
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Users INSERT their own tickets (defence-in-depth — primary path is
-- the service-role edge fn). Service role bypasses RLS by definition.
DROP POLICY IF EXISTS "support_tickets_user_insert" ON public.support_tickets;
CREATE POLICY "support_tickets_user_insert"
  ON public.support_tickets
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Admins SELECT all tickets.
DROP POLICY IF EXISTS "support_tickets_admin_select" ON public.support_tickets;
CREATE POLICY "support_tickets_admin_select"
  ON public.support_tickets
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- Admins UPDATE all tickets.
DROP POLICY IF EXISTS "support_tickets_admin_update" ON public.support_tickets;
CREATE POLICY "support_tickets_admin_update"
  ON public.support_tickets
  FOR UPDATE
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ── 3. updated_at trigger ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.support_tickets_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_tickets_set_updated_at ON public.support_tickets;
CREATE TRIGGER trg_support_tickets_set_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.support_tickets_set_updated_at();

-- ── 4. admin_update_ticket_status RPC ────────────────────────
-- Single write surface for status / assignee / notes changes from the
-- admin Support tab. NULL args leave the corresponding column alone.
CREATE OR REPLACE FUNCTION public.admin_update_ticket_status(
  p_id           UUID,
  p_status       TEXT DEFAULT NULL,
  p_assigned_to  UUID DEFAULT NULL,
  p_admin_notes  TEXT DEFAULT NULL
)
RETURNS public.support_tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.support_tickets;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_update_ticket_status: forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_status IS NOT NULL AND p_status NOT IN ('open','in_progress','resolved','closed') THEN
    RAISE EXCEPTION 'admin_update_ticket_status: invalid status %', p_status USING ERRCODE = '22023';
  END IF;

  UPDATE public.support_tickets
  SET status      = COALESCE(p_status,      status),
      assigned_to = COALESCE(p_assigned_to, assigned_to),
      admin_notes = COALESCE(p_admin_notes, admin_notes)
      -- updated_at is bumped by the trigger.
  WHERE id = p_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_update_ticket_status: ticket not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_update_ticket_status(UUID, TEXT, UUID, TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.admin_update_ticket_status(UUID, TEXT, UUID, TEXT) TO authenticated;

-- ── 5. admin_list_support_tickets RPC ────────────────────────
-- Optional `p_status` filter; returns rows newest-first up to p_limit.
CREATE OR REPLACE FUNCTION public.admin_list_support_tickets(
  p_status TEXT DEFAULT NULL,
  p_limit  INT  DEFAULT 50
)
RETURNS TABLE (
  id           UUID,
  user_id      UUID,
  email        TEXT,
  name         TEXT,
  subject      TEXT,
  body         TEXT,
  topic        TEXT,
  status       TEXT,
  assigned_to  UUID,
  admin_notes  TEXT,
  created_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ,
  total_count  BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total BIGINT;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'admin_list_support_tickets: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_total
  FROM public.support_tickets t
  WHERE p_status IS NULL OR t.status = p_status;

  RETURN QUERY
  SELECT
    t.id, t.user_id, t.email, t.name, t.subject, t.body, t.topic,
    t.status, t.assigned_to, t.admin_notes, t.created_at, t.updated_at,
    v_total AS total_count
  FROM public.support_tickets t
  WHERE p_status IS NULL OR t.status = p_status
  ORDER BY t.created_at DESC
  LIMIT GREATEST(p_limit, 1);
END;
$$;

REVOKE ALL    ON FUNCTION public.admin_list_support_tickets(TEXT, INT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.admin_list_support_tickets(TEXT, INT) TO authenticated;

-- ── 6. support_system_status RPC ─────────────────────────────
-- Public read for the Help page. SECURITY DEFINER so we can read
-- system_logs / video_generation_jobs without leaking PII (we only
-- aggregate counts). Returns a single jsonb with four named buckets.
CREATE OR REPLACE FUNCTION public.support_system_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_render_stuck   INT;
  v_render_active  INT;
  v_render_status  TEXT;
  v_render_detail  TEXT;

  v_voice_failed   INT;
  v_voice_total    INT;
  v_voice_status   TEXT;
  v_voice_detail   TEXT;

  v_media_failed   INT;
  v_media_total    INT;
  v_media_status   TEXT;
  v_media_detail   TEXT;

  v_api_failed     INT;
  v_api_status     TEXT;
  v_api_detail     TEXT;
BEGIN
  -- ── Render queue: stuck = processing + last update > 30 min ago ──
  SELECT COUNT(*) INTO v_render_stuck
  FROM public.video_generation_jobs
  WHERE status = 'processing'
    AND updated_at < NOW() - INTERVAL '30 minutes';

  SELECT COUNT(*) INTO v_render_active
  FROM public.video_generation_jobs
  WHERE status IN ('pending','processing','queued');

  IF v_render_stuck = 0 THEN
    v_render_status := 'operational';
    v_render_detail := v_render_active::text || ' in flight, all healthy';
  ELSIF v_render_stuck <= 3 THEN
    v_render_status := 'degraded';
    v_render_detail := v_render_stuck::text || ' stuck job(s)';
  ELSE
    v_render_status := 'down';
    v_render_detail := v_render_stuck::text || ' stuck job(s)';
  END IF;

  -- ── Voice synthesis: voice_clone_failed events vs successful in last 1h ──
  SELECT
    COUNT(*) FILTER (WHERE event_type IN ('voice_clone_failed','voice_generation_failed')),
    COUNT(*) FILTER (WHERE event_type LIKE 'voice_%')
  INTO v_voice_failed, v_voice_total
  FROM public.system_logs
  WHERE created_at > NOW() - INTERVAL '1 hour';

  IF v_voice_total = 0 OR v_voice_failed = 0 THEN
    v_voice_status := 'operational';
    v_voice_detail := COALESCE(v_voice_total, 0)::text || ' calls, no failures';
  ELSIF (v_voice_failed::numeric / GREATEST(v_voice_total, 1)::numeric) < 0.20 THEN
    v_voice_status := 'degraded';
    v_voice_detail := v_voice_failed::text || ' / ' || v_voice_total::text || ' failed';
  ELSE
    v_voice_status := 'down';
    v_voice_detail := v_voice_failed::text || ' / ' || v_voice_total::text || ' failed';
  END IF;

  -- ── Media pipeline: generations failures vs total in last 1h ──
  SELECT
    COUNT(*) FILTER (WHERE status = 'failed'),
    COUNT(*)
  INTO v_media_failed, v_media_total
  FROM public.generations
  WHERE created_at > NOW() - INTERVAL '1 hour';

  IF v_media_total = 0 OR v_media_failed = 0 THEN
    v_media_status := 'operational';
    v_media_detail := COALESCE(v_media_total, 0)::text || ' renders, no failures';
  ELSIF (v_media_failed::numeric / GREATEST(v_media_total, 1)::numeric) < 0.20 THEN
    v_media_status := 'degraded';
    v_media_detail := v_media_failed::text || ' / ' || v_media_total::text || ' failed';
  ELSE
    v_media_status := 'down';
    v_media_detail := v_media_failed::text || ' / ' || v_media_total::text || ' failed';
  END IF;

  -- ── API & webhooks: system_error rows in last 1h ──
  SELECT COUNT(*) INTO v_api_failed
  FROM public.system_logs
  WHERE category = 'system_error'
    AND created_at > NOW() - INTERVAL '1 hour';

  IF v_api_failed = 0 THEN
    v_api_status := 'operational';
    v_api_detail := 'No errors in the last hour';
  ELSIF v_api_failed <= 5 THEN
    v_api_status := 'degraded';
    v_api_detail := v_api_failed::text || ' error(s) in the last hour';
  ELSE
    v_api_status := 'down';
    v_api_detail := v_api_failed::text || ' errors in the last hour';
  END IF;

  RETURN jsonb_build_object(
    'render_queue',     jsonb_build_object('status', v_render_status, 'detail', v_render_detail),
    'voice_synthesis',  jsonb_build_object('status', v_voice_status,  'detail', v_voice_detail),
    'media_pipeline',   jsonb_build_object('status', v_media_status,  'detail', v_media_detail),
    'api_webhooks',     jsonb_build_object('status', v_api_status,    'detail', v_api_detail)
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.support_system_status() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_system_status() TO authenticated;

COMMIT;
