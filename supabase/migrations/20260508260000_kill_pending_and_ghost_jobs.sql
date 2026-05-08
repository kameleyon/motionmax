-- ============================================================
-- Operational reset: cancel all pending + ghost jobs
-- ============================================================
-- One-off operator action — wipe the queue clean after the
-- 2026-05-08 kill-switch / collision incident. Anything still
-- pending or claimed but not finishing is cancelled with a clear
-- reason so the user-facing dashboards stop spinning.
--
-- Idempotent: re-running has no effect once everything is settled.

BEGIN;

-- 1. video_generation_jobs — pending + ghost-processing.
UPDATE public.video_generation_jobs
   SET status = 'failed',
       error_message = 'Cancelled by operator (queue reset 2026-05-08)',
       updated_at = NOW()
 WHERE status IN ('pending', 'processing');

-- 2. autopost_runs in any non-terminal state.
UPDATE public.autopost_runs
   SET status = 'cancelled',
       error_summary = 'Cancelled by operator (queue reset 2026-05-08)',
       progress_pct = NULL
 WHERE status IN ('queued', 'generating', 'rendered', 'publishing');

-- 3. autopost_publish_jobs in flight.
UPDATE public.autopost_publish_jobs
   SET status = 'failed',
       error_message = 'Cancelled by operator (queue reset 2026-05-08)',
       updated_at = NOW()
 WHERE status IN ('pending', 'uploading', 'processing');

-- 4. newsletter_campaigns currently sending or scheduled.
UPDATE public.newsletter_campaigns
   SET status = 'cancelled',
       updated_at = NOW()
 WHERE status IN ('scheduled', 'sending');

-- 5. newsletter_sends pending → mark failed so the worker doesn't
--    pick them up on the next campaign re-fire.
UPDATE public.newsletter_sends
   SET status = 'failed',
       error = 'Cancelled by operator (queue reset 2026-05-08)',
       sent_at = NOW()
 WHERE status = 'pending';

-- 6. Flush worker_heartbeats so stale rows don't trick the admin
--    Performance tab. The 5-min janitor cron would do this anyway,
--    but explicit reset is cleaner.
DELETE FROM public.worker_heartbeats
 WHERE last_beat_at < NOW() - INTERVAL '90 seconds';

-- 7. Clear the stale-claim reaper's job-restart counter on the
--    rows we just marked failed — so a manual requeue from the UI
--    doesn't immediately trip the MAX_RESTART_RETRIES gate.
UPDATE public.video_generation_jobs
   SET payload = payload - '_restartCount'
 WHERE status = 'failed'
   AND payload ? '_restartCount';

-- 8. Audit log — record the wipe.
INSERT INTO public.admin_logs (admin_id, action, target_type, target_id, details)
VALUES (
  NULL,
  'queue_reset',
  'system',
  NULL,
  jsonb_build_object(
    'reason', 'kill all pending + ghost processes (2026-05-08)',
    'tables_wiped', jsonb_build_array(
      'video_generation_jobs', 'autopost_runs', 'autopost_publish_jobs',
      'newsletter_campaigns', 'newsletter_sends', 'worker_heartbeats'
    )
  )
);

COMMIT;
