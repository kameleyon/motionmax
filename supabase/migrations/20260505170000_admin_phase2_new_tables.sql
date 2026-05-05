-- ============================================================
-- Admin rebuild — Phase 2.5: ten greenfield tables
-- ============================================================
-- WHAT: Creates the new tables the admin tabs depend on,
--   each with RLS enabled + forced at create time:
--     1. admin_message_threads      (Phase 13.1 — Messages)
--     2. admin_messages              (Phase 13.1)
--     3. notification_templates      (Phase 14.1 — Notifications)
--     4. user_notifications          (Phase 14.1)
--     5. newsletter_campaigns        (Phase 15.1 — Newsletter)
--     6. newsletter_sends            (Phase 15.1)
--     7. announcements               (Phase 16.1 — Announcements)
--     8. announcement_dismissals     (Phase 16.1)
--     9. worker_heartbeats           (Phase 10.4 — Performance)
--    10. user_provider_keys          (Phase 7.1 — API Keys)
--   Plus the safe view admin_v_user_provider_keys exposing
--   only metadata (never ciphertext).
--
-- WHY:  These features are entirely greenfield — the existing
--       schema has no analogue. Building them up-front unblocks
--       the per-tab work in later phases.
--
-- POLICY SHAPE (every table):
--   * ENABLE + FORCE ROW LEVEL SECURITY
--   * user-scope policy where applicable (own rows only)
--   * admin SELECT policy: USING (public.is_admin(auth.uid()))
--   * service_role policy: full access (writes via SECURITY
--     DEFINER RPCs in later migrations)
--   * anon RESTRICTIVE deny
--
-- IMPLEMENTS: ADMIN_REBUILD_CHECKLIST.md section 2.5.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. admin_message_threads  (Phase 13.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.admin_message_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject         text NOT NULL,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','answered','closed')),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  closed_by       uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS admin_message_threads_user_id_created_at_idx
  ON public.admin_message_threads (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_message_threads_status_last_message_at_idx
  ON public.admin_message_threads (status, last_message_at DESC);

ALTER TABLE public.admin_message_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_message_threads FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS amt_user_select        ON public.admin_message_threads;
DROP POLICY IF EXISTS amt_admin_select       ON public.admin_message_threads;
DROP POLICY IF EXISTS amt_service_role_all   ON public.admin_message_threads;
DROP POLICY IF EXISTS amt_deny_anon          ON public.admin_message_threads;

CREATE POLICY amt_user_select       ON public.admin_message_threads FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY amt_admin_select      ON public.admin_message_threads FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY amt_service_role_all  ON public.admin_message_threads FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY amt_deny_anon         ON public.admin_message_threads AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ============================================================
-- 2. admin_messages  (Phase 13.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.admin_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES public.admin_message_threads(id) ON DELETE CASCADE,
  sender_id   uuid NOT NULL REFERENCES auth.users(id),
  sender_role text NOT NULL CHECK (sender_role IN ('user','admin','system')),
  body        text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_messages_thread_id_created_at_idx
  ON public.admin_messages (thread_id, created_at);

ALTER TABLE public.admin_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_messages FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS am_user_select         ON public.admin_messages;
DROP POLICY IF EXISTS am_admin_select        ON public.admin_messages;
DROP POLICY IF EXISTS am_service_role_all    ON public.admin_messages;
DROP POLICY IF EXISTS am_deny_anon           ON public.admin_messages;

CREATE POLICY am_user_select        ON public.admin_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_message_threads t
      WHERE t.id = thread_id AND t.user_id = auth.uid()
    )
  );
CREATE POLICY am_admin_select       ON public.admin_messages FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY am_service_role_all   ON public.admin_messages FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY am_deny_anon          ON public.admin_messages AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ============================================================
-- 3. notification_templates  (Phase 14.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.notification_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text UNIQUE NOT NULL,
  title_template   text NOT NULL,
  body_template    text NOT NULL,
  cta_url_template text,
  icon             text,
  severity         text NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('info','success','warn','error')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_templates FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nt_admin_select        ON public.notification_templates;
DROP POLICY IF EXISTS nt_service_role_all    ON public.notification_templates;
DROP POLICY IF EXISTS nt_deny_anon           ON public.notification_templates;

CREATE POLICY nt_admin_select       ON public.notification_templates FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY nt_service_role_all   ON public.notification_templates FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY nt_deny_anon          ON public.notification_templates AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ============================================================
-- 4. user_notifications  (Phase 14.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  template_slug     text REFERENCES public.notification_templates(slug),
  title             text NOT NULL,
  body              text NOT NULL,
  cta_url           text,
  icon              text,
  severity          text NOT NULL DEFAULT 'info'
                      CHECK (severity IN ('info','success','warn','error')),
  delivered_at      timestamptz,
  read_at           timestamptz,
  dismissed_at      timestamptz,
  scheduled_for     timestamptz,
  sent_by_admin_id  uuid REFERENCES auth.users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_notifications_user_id_delivered_at_idx
  ON public.user_notifications (user_id, delivered_at DESC)
  WHERE dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS user_notifications_scheduled_for_pending_idx
  ON public.user_notifications (scheduled_for)
  WHERE scheduled_for IS NOT NULL AND delivered_at IS NULL;

ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notifications FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS un_user_select         ON public.user_notifications;
DROP POLICY IF EXISTS un_user_update         ON public.user_notifications;
DROP POLICY IF EXISTS un_admin_select        ON public.user_notifications;
DROP POLICY IF EXISTS un_service_role_all    ON public.user_notifications;
DROP POLICY IF EXISTS un_deny_anon           ON public.user_notifications;

CREATE POLICY un_user_select        ON public.user_notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY un_user_update        ON public.user_notifications FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY un_admin_select       ON public.user_notifications FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY un_service_role_all   ON public.user_notifications FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY un_deny_anon          ON public.user_notifications AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ============================================================
-- 5. newsletter_campaigns  (Phase 15.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.newsletter_campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject         text NOT NULL,
  body_html       text NOT NULL,
  body_text       text,
  audience        text NOT NULL DEFAULT 'all_opted_in',
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','scheduled','sending','sent','cancelled')),
  scheduled_for   timestamptz,
  sent_at         timestamptz,
  created_by      uuid NOT NULL REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS newsletter_campaigns_status_scheduled_for_idx
  ON public.newsletter_campaigns (status, scheduled_for);

ALTER TABLE public.newsletter_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletter_campaigns FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nc_admin_select        ON public.newsletter_campaigns;
DROP POLICY IF EXISTS nc_service_role_all    ON public.newsletter_campaigns;
DROP POLICY IF EXISTS nc_deny_anon           ON public.newsletter_campaigns;

CREATE POLICY nc_admin_select       ON public.newsletter_campaigns FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY nc_service_role_all   ON public.newsletter_campaigns FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY nc_deny_anon          ON public.newsletter_campaigns AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ============================================================
-- 6. newsletter_sends  (Phase 15.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.newsletter_sends (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid NOT NULL REFERENCES public.newsletter_campaigns(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email               text NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','sent','bounced','complained','opened','clicked','failed')),
  resend_message_id   text,
  sent_at             timestamptz,
  opened_at           timestamptz,
  clicked_at          timestamptz,
  error               text,
  UNIQUE (campaign_id, user_id)
);

CREATE INDEX IF NOT EXISTS newsletter_sends_campaign_id_status_idx
  ON public.newsletter_sends (campaign_id, status);

ALTER TABLE public.newsletter_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletter_sends FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ns_admin_select        ON public.newsletter_sends;
DROP POLICY IF EXISTS ns_user_select         ON public.newsletter_sends;
DROP POLICY IF EXISTS ns_service_role_all    ON public.newsletter_sends;
DROP POLICY IF EXISTS ns_deny_anon           ON public.newsletter_sends;

CREATE POLICY ns_user_select        ON public.newsletter_sends FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY ns_admin_select       ON public.newsletter_sends FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY ns_service_role_all   ON public.newsletter_sends FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY ns_deny_anon          ON public.newsletter_sends AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ============================================================
-- 7. announcements  (Phase 16.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.announcements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  body_md         text NOT NULL,
  severity        text NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('info','warn','critical','feature')),
  cta_label       text,
  cta_url         text,
  audience        jsonb NOT NULL DEFAULT '{"plan":"all"}'::jsonb,
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS announcements_active_starts_ends_idx
  ON public.announcements (active, starts_at, ends_at);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ann_active_select       ON public.announcements;
DROP POLICY IF EXISTS ann_admin_select        ON public.announcements;
DROP POLICY IF EXISTS ann_service_role_all    ON public.announcements;
DROP POLICY IF EXISTS ann_deny_anon           ON public.announcements;

-- Authenticated users can read currently-live announcements; the
-- audience predicate filtering happens in the RPC current_announcements_for_me.
CREATE POLICY ann_active_select     ON public.announcements FOR SELECT TO authenticated
  USING (active AND now() >= starts_at AND (ends_at IS NULL OR now() <= ends_at));
CREATE POLICY ann_admin_select      ON public.announcements FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY ann_service_role_all  ON public.announcements FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY ann_deny_anon         ON public.announcements AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ============================================================
-- 8. announcement_dismissals  (Phase 16.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.announcement_dismissals (
  announcement_id uuid REFERENCES public.announcements(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  dismissed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

ALTER TABLE public.announcement_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_dismissals FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS adm_user_select         ON public.announcement_dismissals;
DROP POLICY IF EXISTS adm_user_insert         ON public.announcement_dismissals;
DROP POLICY IF EXISTS adm_admin_select        ON public.announcement_dismissals;
DROP POLICY IF EXISTS adm_service_role_all    ON public.announcement_dismissals;
DROP POLICY IF EXISTS adm_deny_anon           ON public.announcement_dismissals;

CREATE POLICY adm_user_select       ON public.announcement_dismissals FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY adm_user_insert       ON public.announcement_dismissals FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY adm_admin_select      ON public.announcement_dismissals FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY adm_service_role_all  ON public.announcement_dismissals FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY adm_deny_anon         ON public.announcement_dismissals AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ============================================================
-- 9. worker_heartbeats  (Phase 10.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.worker_heartbeats (
  worker_id           text PRIMARY KEY,
  host                text,
  last_beat_at        timestamptz NOT NULL DEFAULT now(),
  in_flight           int  NOT NULL DEFAULT 0,
  concurrency         int  NOT NULL DEFAULT 0,
  memory_pct          numeric,
  cpu_pct             numeric,
  version             text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  restart_requested   boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_last_beat_at_idx
  ON public.worker_heartbeats (last_beat_at DESC);

ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_heartbeats FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wh_admin_select        ON public.worker_heartbeats;
DROP POLICY IF EXISTS wh_service_role_all    ON public.worker_heartbeats;
DROP POLICY IF EXISTS wh_deny_anon           ON public.worker_heartbeats;

CREATE POLICY wh_admin_select       ON public.worker_heartbeats FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));
CREATE POLICY wh_service_role_all   ON public.worker_heartbeats FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY wh_deny_anon          ON public.worker_heartbeats AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- ============================================================
-- 10. user_provider_keys  (Phase 7.1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_provider_keys (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider               text NOT NULL CHECK (provider IN (
                            'openrouter','elevenlabs','fish_audio','hypereal',
                            'grok','lyria','lemonfox','smallest','google_tts',
                            'replicate','openai','sendgrid','stripe','sentry'
                         )),
  key_ciphertext         text NOT NULL,
  last_validated_at      timestamptz,
  last_validation_error  text,
  status                 text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','disabled','revoked')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS user_provider_keys_provider_status_idx
  ON public.user_provider_keys (provider, status);

ALTER TABLE public.user_provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_provider_keys FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS upk_user_select         ON public.user_provider_keys;
DROP POLICY IF EXISTS upk_service_role_all    ON public.user_provider_keys;
DROP POLICY IF EXISTS upk_deny_anon           ON public.user_provider_keys;

-- IMPORTANT: NO admin SELECT policy on user_provider_keys — the
-- ciphertext must never reach an admin client. Admin reads go
-- through the safe view admin_v_user_provider_keys below.
CREATE POLICY upk_user_select       ON public.user_provider_keys FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY upk_service_role_all  ON public.user_provider_keys FOR ALL    TO service_role  USING (true) WITH CHECK (true);
CREATE POLICY upk_deny_anon         ON public.user_provider_keys AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- Safe admin view: metadata only, never ciphertext.
CREATE OR REPLACE VIEW public.admin_v_user_provider_keys
WITH (security_invoker = true) AS
SELECT
  upk.user_id,
  upk.provider,
  upk.status,
  upk.last_validated_at,
  upk.last_validation_error AS last_error,
  upk.created_at,
  upk.updated_at
FROM public.user_provider_keys upk
WHERE public.is_admin(auth.uid());

REVOKE ALL ON public.admin_v_user_provider_keys FROM anon;
GRANT  SELECT ON public.admin_v_user_provider_keys TO authenticated;

COMMIT;
