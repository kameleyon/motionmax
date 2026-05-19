-- ============================================================
-- Outbox pattern: durable result store for video_generation_jobs
-- terminal writes, so DB pressure can no longer strand jobs.
-- ============================================================
-- Background: the worker computes a video result in memory (5–10
-- minutes of work) and then UPDATEs video_generation_jobs to mark
-- the job 'completed'. When the DB is under load (cron storms,
-- connection-pool saturation, lock contention), that single UPDATE
-- can time out — the in-memory result is lost and the job stays in
-- 'processing' until the stale-claim reaper resets it 90 minutes
-- later, at which point the next worker has to RE-DO the work.
-- Today (2026-05-18) the user saw this happen multiple times.
--
-- Outbox pattern fix:
--   1. Worker writes the result to job_results FIRST (one small,
--      contention-free INSERT/UPSERT — almost always succeeds).
--   2. Worker then tries the regular UPDATE. On success, marks the
--      outbox row applied_at=now().
--   3. A sweeper function runs every minute, picks up any outbox
--      rows still unapplied >30s after creation, and applies them
--      using the SAME (id, worker_id, status='processing') filter
--      the worker uses — so cancellations / reaper handoffs are
--      never clobbered.
--
-- Worst case: a stranded job recovers in <60s instead of 90min.
-- ============================================================

BEGIN;

-- ── Outbox table ───────────────────────────────────────────────
-- One row per terminal-write attempt. Keyed by job_id so the
-- worker's UPSERT replaces any stale prior attempt (e.g., the
-- reaper revived this job and a new worker is finishing it).
CREATE TABLE IF NOT EXISTS public.job_results (
  job_id      uuid        PRIMARY KEY
              REFERENCES public.video_generation_jobs(id) ON DELETE CASCADE,
  result      jsonb       NOT NULL,
  worker_id   text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz NULL
);

-- Hot path for the sweeper: only scans unapplied rows. Partial
-- index keeps it tiny — applied rows are excluded from the index
-- entirely, so the WHERE applied_at IS NULL scan is essentially a
-- bounded index range read.
CREATE INDEX IF NOT EXISTS idx_job_results_unapplied
  ON public.job_results (created_at)
  WHERE applied_at IS NULL;

-- RLS: outbox is service-role only. Frontend NEVER reads this — the
-- final result is on video_generation_jobs.result once applied.
ALTER TABLE public.job_results ENABLE ROW LEVEL SECURITY;

-- No policies = nobody but service_role can read/write. (RLS without
-- policies = deny-all for anon + authenticated.)

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_results TO service_role;

COMMENT ON TABLE public.job_results IS
  'Outbox for worker terminal-write results. Worker UPSERTs before the regular video_generation_jobs UPDATE; sweeper apply_outbox_results() picks up any unapplied rows >30s old when the worker UPDATE timed out. Recovers stranded jobs in <60s instead of 90min reaper window.';

-- ── Sweeper function ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_outbox_results()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $$
DECLARE
  applied_count integer := 0;
  r RECORD;
  v_updated   boolean;
  v_terminal  boolean;
BEGIN
  -- LIMIT 50 keeps the sweeper bounded if many results pile up at
  -- once. At every-minute cadence that's 3000 results/hour of
  -- recovery capacity — well above any realistic incident.
  FOR r IN
    SELECT job_id, result, worker_id
    FROM public.job_results
    WHERE applied_at IS NULL
      -- 30s grace: the worker has its own retry; let it run first.
      -- Acts as a debounce — the sweeper only catches rows the worker
      -- DEFINITELY couldn't apply itself.
      AND created_at < now() - interval '30 seconds'
    ORDER BY created_at
    LIMIT 50
  LOOP
    -- Try the same (id, worker_id, status='processing') filter the
    -- worker uses. If the row is already terminal (reaper handed
    -- off, user cancelled, worker came back and finished), this
    -- matches 0 rows and we move on — no clobber.
    WITH upd AS (
      UPDATE public.video_generation_jobs
      SET    status     = 'completed',
             progress   = 100,
             result     = r.result,
             payload    = r.result,
             updated_at = now()
      WHERE  id        = r.job_id
        AND  worker_id = r.worker_id
        AND  status    = 'processing'
      RETURNING 1
    )
    SELECT EXISTS(SELECT 1 FROM upd) INTO v_updated;

    IF v_updated THEN
      applied_count := applied_count + 1;
    ELSE
      -- We didn't apply (job already terminal / reassigned). Check
      -- if it's truly terminal so we can mark the outbox row applied
      -- and stop the sweeper from re-trying it forever.
      SELECT EXISTS(
        SELECT 1 FROM public.video_generation_jobs
        WHERE  id     = r.job_id
          AND  status IN ('completed', 'failed', 'cancelled')
      ) INTO v_terminal;

      -- If not terminal AND not ours to apply, leave the row alone —
      -- the reaper may revive it for a new worker, who will write
      -- a fresh outbox row that supersedes this one (PK conflict
      -- → UPSERT overwrites).
      IF NOT v_terminal THEN
        CONTINUE;
      END IF;
    END IF;

    -- Mark outbox row applied so we never re-do this work.
    UPDATE public.job_results
    SET    applied_at = now()
    WHERE  job_id = r.job_id;
  END LOOP;

  RETURN applied_count;
END $$;

REVOKE ALL ON FUNCTION public.apply_outbox_results() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_outbox_results() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_outbox_results() TO service_role;

COMMENT ON FUNCTION public.apply_outbox_results() IS
  'Sweeper for the job_results outbox. Applies any result row unapplied >30s, using the same (id, worker_id, status=processing) filter as the worker. Idempotent — already-terminal rows are marked applied. Scheduled every minute via pg_cron job apply-outbox-results. Returns the number of rows newly applied.';

-- ── pg_cron schedule (every minute, alongside autopost-tick) ──
-- Every minute is intentional — when a job is stranded, we want it
-- recovered ASAP. The sweeper is cheap (one SELECT + at most 50
-- small UPDATEs) and rides the same minute as autopost-tick, which
-- is the only every-minute job. No new cron-minute collisions.
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('apply-outbox-results');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'apply-outbox-results',
  '* * * * *',
  $$ SELECT public.apply_outbox_results(); $$
);

COMMIT;
