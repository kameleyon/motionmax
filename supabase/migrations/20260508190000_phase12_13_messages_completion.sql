-- ============================================================
-- Phase 12 + 13 — Console export prep + Messages completion
-- ============================================================
-- Closes the remaining checklist items:
--   13.2 — open_thread_as_user (user-side thread creation)
--   13.2 — admin_flag_thread (admin-side tag toggle)
--   13.7 — support_templates table + seed (welcome / refund_processed
--          / bug_acknowledged / feature_logged / closing_thread)
-- Adds: admin_message_threads.tags text[] column for the flag chips.
--
-- Phase 12.5 (Export CSV) is client-side only — no schema changes.

BEGIN;

-- ── 13.2 schema: tags column for thread flags ──────────────────────
ALTER TABLE public.admin_message_threads
  ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS admin_message_threads_tags_gin_idx
  ON public.admin_message_threads USING gin (tags)
  WHERE tags <> '{}'::text[];

-- ── 13.2 RPC: open_thread_as_user ───────────────────────────────────
-- User-callable. Creates a thread + first user message in one round-
-- trip. The Help page form lives entirely in the user's session, so
-- we drive it off auth.uid() instead of taking p_user_id.
CREATE OR REPLACE FUNCTION public.open_thread_as_user(
  p_subject text,
  p_body    text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE
  v_uid    uuid := auth.uid();
  v_thread uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'open_thread_as_user: not authenticated' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(TRIM(p_subject), '') = '' OR COALESCE(TRIM(p_body), '') = '' THEN
    RAISE EXCEPTION 'open_thread_as_user: subject and body are required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.admin_message_threads (user_id, subject, status)
  VALUES (v_uid, LEFT(p_subject, 200), 'open')
  RETURNING id INTO v_thread;

  INSERT INTO public.admin_messages (thread_id, sender_id, sender_role, body)
  VALUES (v_thread, v_uid, 'user', p_body);

  -- Bump last_message_at to match the inserted message timestamp
  -- (admin_messages's default is now(); this stays consistent).
  UPDATE public.admin_message_threads SET last_message_at = NOW() WHERE id = v_thread;

  RETURN v_thread;
END;
$func$;

REVOKE ALL ON FUNCTION public.open_thread_as_user(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.open_thread_as_user(text, text) TO authenticated;

-- ── 13.2 RPC: admin_flag_thread ─────────────────────────────────────
-- Admin-only. Replaces the thread's tags[] wholesale with the passed
-- array (empty array clears flags). Audit-logged so future blame
-- queries can attribute a tag change to a specific admin.
CREATE OR REPLACE FUNCTION public.admin_flag_thread(
  p_thread_id uuid,
  p_flags     text[]
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $func$
DECLARE
  v_admin uuid := auth.uid();
  v_prev  text[];
BEGIN
  IF v_admin IS NULL OR NOT public.is_admin(v_admin) THEN
    RAISE EXCEPTION 'admin_flag_thread: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT tags INTO v_prev FROM public.admin_message_threads WHERE id = p_thread_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_flag_thread: thread not found' USING ERRCODE = '02000';
  END IF;

  UPDATE public.admin_message_threads
     SET tags = COALESCE(p_flags, '{}'::text[])
   WHERE id = p_thread_id;

  INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
  VALUES (
    v_admin, 'flag_thread', 'message_thread', p_thread_id,
    jsonb_build_object('previous', v_prev, 'next', COALESCE(p_flags, ARRAY[]::text[]))
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.admin_flag_thread(uuid, text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_flag_thread(uuid, text[]) TO authenticated;

-- ── 13.7 support_templates table ────────────────────────────────────
-- Slug-keyed canned-reply library for the Messages tab Templates
-- picker. Admin-managed; no per-user variants — the message body uses
-- mustache-style {{display_name}} / {{plan_name}} placeholders that
-- the client substitutes at paste time.
CREATE TABLE IF NOT EXISTS public.support_templates (
  slug       text PRIMARY KEY,
  title      text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.support_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS st_admin_all ON public.support_templates;
CREATE POLICY st_admin_all ON public.support_templates
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Seed the 5 starter templates the spec calls out. ON CONFLICT skips
-- existing slugs so this migration is safe to re-run.
INSERT INTO public.support_templates (slug, title, body) VALUES
  ('welcome',
   'Welcome to MotionMax',
   'Hi {{display_name}},

Thanks for signing up! Your {{plan_name}} plan is active and you''re ready to create your first video.

Quick start tips:
• Pick a style and length, drop in a topic, and hit Generate.
• Bring your own brand colors and voice for a consistent look.
• Try Auto-post to publish on a schedule (Creator plan).

Reply if you get stuck — we read every message.

— MotionMax Support'),

  ('refund_processed',
   'Your refund has been processed',
   'Hi {{display_name}},

Just confirming: we''ve refunded the credits for your most recent generation. The balance should appear on your account within a minute.

We''re sorry the render didn''t come out right. If you''d like, reply with what went wrong and we''ll log it for the team — your feedback helps us tune the model.

— MotionMax Support'),

  ('bug_acknowledged',
   'We''re looking into this',
   'Hi {{display_name}},

Thanks for the report — we''ve logged this on our end and an engineer is taking a look. We''ll write back here as soon as we have an update or a fix in place.

If you can, please reply with the project ID so we can trace your specific generation in our logs.

— MotionMax Support'),

  ('feature_logged',
   'Feature request received',
   'Hi {{display_name}},

Thanks for the suggestion — we''ve logged it for the product team to review. We can''t commit to a timeline, but ideas from active users carry the most weight when we plan upcoming releases.

We''ll reach back out if we ship something related.

— MotionMax Support'),

  ('closing_thread',
   'Anything else we can help with?',
   'Hi {{display_name}},

Looks like we''ve got everything covered for now — going to mark this thread as resolved. If anything else comes up, just reply here and it''ll re-open automatically.

Thanks for using MotionMax!

— MotionMax Support')
ON CONFLICT (slug) DO NOTHING;

-- updated_at trigger so edits surface in the picker preview without
-- the admin having to manually bump a timestamp.
CREATE OR REPLACE FUNCTION public.support_templates_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$func$;

DROP TRIGGER IF EXISTS support_templates_updated_at ON public.support_templates;
CREATE TRIGGER support_templates_updated_at
  BEFORE UPDATE ON public.support_templates
  FOR EACH ROW EXECUTE FUNCTION public.support_templates_set_updated_at();

COMMIT;
