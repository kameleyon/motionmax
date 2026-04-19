-- ============================================================
-- Fix account deletion race condition + ElevenLabs cleanup
--
-- Problems fixed:
--   1. process_due_deletions() had no row-level locking — two
--      concurrent cron invocations could process the same
--      deletion_request simultaneously, causing duplicate deletes
--      and partial state.
--   2. user_voices rows were deleted from the DB but the
--      corresponding ElevenLabs voices were never cleaned up,
--      leaking external resources.
--
-- Solution:
--   • Use SELECT … FOR UPDATE SKIP LOCKED so each deletion_request
--     is claimed by exactly one worker process.
--   • Add a deletion_tasks table for external-service cleanup
--     (ElevenLabs, Stripe, etc.) that a worker/cron can drain.
--   • Capture user_voices before the cascade delete so we can
--     enqueue ElevenLabs deletion tasks.
-- ============================================================

-- ── 1. deletion_tasks table ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.deletion_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type     TEXT NOT NULL,         -- e.g. 'elevenlabs_voice', 'stripe_cancel'
  payload       JSONB NOT NULL,        -- task-specific data
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deletion_tasks_status_idx
  ON public.deletion_tasks(status)
  WHERE status IN ('pending', 'failed');

-- Only service_role can read/write deletion tasks
ALTER TABLE public.deletion_tasks ENABLE ROW LEVEL SECURITY;
-- (no public policies — service_role bypasses RLS)

-- ── 2. Replace process_due_deletions with a race-safe version ─

CREATE OR REPLACE FUNCTION public.process_due_deletions()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
DECLARE
  req         RECORD;
  voice_rec   RECORD;
  processed   INT := 0;
BEGIN
  -- Claim up to 50 pending requests atomically.
  -- FOR UPDATE SKIP LOCKED means concurrent callers each get a
  -- disjoint set — no two workers will process the same row.
  FOR req IN
    SELECT id, user_id
    FROM deletion_requests
    WHERE status = 'pending'
      AND scheduled_at <= NOW()
    ORDER BY scheduled_at ASC
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      -- Enqueue ElevenLabs voice deletion tasks BEFORE the cascade
      -- deletes user_voices.
      FOR voice_rec IN
        SELECT voice_id FROM public.user_voices WHERE user_id = req.user_id
      LOOP
        INSERT INTO public.deletion_tasks(task_type, payload)
        VALUES ('elevenlabs_voice', jsonb_build_object('voice_id', voice_rec.voice_id, 'user_id', req.user_id));
      END LOOP;

      -- Delegate to the existing single-request function
      PERFORM public.process_deletion_request(req.id);

      processed := processed + 1;

    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'process_due_deletions: failed for request %: %', req.id, SQLERRM;
    END;
  END LOOP;

  RETURN processed;
END;
$$;

-- Keep same permission model as before
REVOKE ALL ON FUNCTION public.process_due_deletions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_due_deletions() TO service_role;
