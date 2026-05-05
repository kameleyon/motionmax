-- ============================================================
-- Admin rebuild — Phase 2.6: realtime publication additions
-- ============================================================
-- WHAT: Adds nine tables to the supabase_realtime publication so
--       the admin dashboards can subscribe and update without
--       polling:
--         system_logs               (Console live tail)
--         video_generation_jobs     (Generations status flips)
--         feature_flags             (Kill switches mirror)
--         app_settings              (master kill mirror)
--         user_notifications        (in-app push)
--         announcements             (banner refresh)
--         admin_messages            (inbox push)
--         admin_message_threads     (thread state)
--         dead_letter_jobs          (Generations DLQ live)
--
-- WHY:  RLS already gates SELECT on each table to admins (or to
--       the row's user). Realtime respects those policies, so a
--       non-admin client cannot subscribe to logs they cannot
--       SELECT. Adding to the publication is the only blocker.
--
-- IDEMPOTENCY: each ALTER PUBLICATION is wrapped in a DO block
--   with EXCEPTION OTHERS so re-running this migration when a
--   table is already in the publication does not fail.
--
-- IMPLEMENTS: ADMIN_REBUILD_CHECKLIST.md section 2.6.
-- ============================================================

BEGIN;

-- The supabase_realtime publication is created by the platform.
-- If absent (e.g. brand-new local dev DB), create it empty so
-- the ALTERs below have a target.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.system_logs;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.video_generation_jobs;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.feature_flags;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_notifications;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.announcements;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_messages;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_message_threads;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.dead_letter_jobs;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END;
$$;

COMMIT;
