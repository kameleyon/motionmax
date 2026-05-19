-- ============================================================
-- Heartbeat-based stale-claim reaper.
-- ============================================================
-- Complements the existing time-based reaper at worker/src/lib/
-- staleClaimReaper.ts (which uses video_generation_jobs.updated_at
-- with 90–120 min windows — too coarse for fast recovery). This
-- function uses worker_heartbeats.last_beat_at instead: if a worker
-- hasn't beat in >90 s it's considered dead, and any 'processing'
-- jobs it owns get the same fail-closed-vs-revive treatment the
-- existing reaper applies.
--
-- Detection latency:
--   - Worker writes heartbeat every 15 s (see worker/src/lib/heartbeat.ts).
--   - Cutoff is 90 s stale (6× the heartbeat interval — long enough
--     to absorb network jitter / DB pressure window without false-
--     positives, short enough that a real death is caught in ~1-2 min).
--   - pg_cron runs us every minute → worst case detection = 90 s +
--     polling jitter ≈ 2 min. Time-based reaper backstop stays at
--     90 min for the case where EVERYTHING is broken.
--
-- Fail-closed policy mirrors staleClaimReaper.ts (autopost_*
-- orchestrators are non-idempotent and double-spend on revive —
-- never resurrect them).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.reap_dead_worker_jobs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $$
DECLARE
  -- 6× the 15-second heartbeat interval. Generous enough that a
  -- single missed beat (network hiccup, brief connection pressure)
  -- doesn't trigger a false positive.
  cutoff timestamptz := now() - interval '90 seconds';
  failed_orchestrator_count integer := 0;
  reset_count               integer := 0;
  reset_task_types          text[]   := '{}';
BEGIN
  -- ── 1. Fail-close orchestrators whose worker is dead ─────────
  -- Same policy as the time-based reaper: autopost_render and
  -- autopost_rerender create child rows + spend credits on every
  -- run, so resurrecting them double-spends. Mark failed and let
  -- the user retry from the UI.
  WITH dead_workers AS (
    SELECT DISTINCT vj.worker_id
    FROM   public.video_generation_jobs vj
    WHERE  vj.status    = 'processing'
      AND  vj.worker_id IS NOT NULL
      AND  NOT EXISTS (
        SELECT 1 FROM public.worker_heartbeats wh
        WHERE  wh.worker_id    = vj.worker_id
          AND  wh.last_beat_at > cutoff
      )
  ),
  failed AS (
    UPDATE public.video_generation_jobs vj
    SET    status        = 'failed',
           error_message = 'Worker died (heartbeat stale >90s). Failed-closed by heartbeat reaper to prevent duplicate spend on retry.',
           updated_at    = now()
    FROM   dead_workers dw
    WHERE  vj.worker_id = dw.worker_id
      AND  vj.status    = 'processing'
      AND  vj.task_type IN ('autopost_render', 'autopost_rerender')
    RETURNING vj.id, vj.payload
  )
  SELECT count(*) INTO failed_orchestrator_count FROM failed;

  -- Mirror the orchestrator failure into autopost_runs so the
  -- dashboard stops showing GENERATING X %.
  IF failed_orchestrator_count > 0 THEN
    UPDATE public.autopost_runs ar
    SET    status        = 'failed',
           error_summary = 'Orchestrator orphaned (worker died); refused to retry',
           progress_pct  = NULL
    WHERE  ar.id IN (
      SELECT (vj.payload ->> 'autopost_run_id')::uuid
      FROM   public.video_generation_jobs vj
      WHERE  vj.status        = 'failed'
        AND  vj.task_type     IN ('autopost_render','autopost_rerender')
        AND  vj.error_message LIKE 'Worker died (heartbeat stale%'
        AND  vj.updated_at    > now() - interval '10 seconds'
        AND  vj.payload       ? 'autopost_run_id'
    )
      AND  ar.status <> 'completed';
  END IF;

  -- ── 2. Reset every other dead-worker-owned job to pending ────
  -- Idempotent task types (cinematic_video has resume checkpoints,
  -- image gen / TTS are single API calls that retry cleanly).
  -- Setting worker_id=NULL releases the claim so claim_pending_job
  -- can re-acquire on the next worker poll.
  WITH dead_workers AS (
    SELECT DISTINCT vj.worker_id
    FROM   public.video_generation_jobs vj
    WHERE  vj.status    = 'processing'
      AND  vj.worker_id IS NOT NULL
      AND  NOT EXISTS (
        SELECT 1 FROM public.worker_heartbeats wh
        WHERE  wh.worker_id    = vj.worker_id
          AND  wh.last_beat_at > cutoff
      )
  ),
  reset AS (
    UPDATE public.video_generation_jobs vj
    SET    status     = 'pending',
           worker_id  = NULL,
           updated_at = now()
    FROM   dead_workers dw
    WHERE  vj.worker_id = dw.worker_id
      AND  vj.status    = 'processing'
      AND  vj.task_type NOT IN ('autopost_render', 'autopost_rerender')
    RETURNING vj.task_type
  )
  SELECT count(*), array_agg(DISTINCT task_type)
  INTO   reset_count, reset_task_types
  FROM   reset;

  -- Audit log — same shape as staleClaimReaper.ts so dashboard
  -- log search keeps working.
  IF reset_count > 0 OR failed_orchestrator_count > 0 THEN
    INSERT INTO public.system_logs (
      id, category, event_type, message, details, created_at
    ) VALUES (
      gen_random_uuid(),
      'system_warning',
      'heartbeat_reaper_acted',
      format('Heartbeat reaper: reset %s job(s), fail-closed %s orchestrator(s)',
             reset_count, failed_orchestrator_count),
      jsonb_build_object(
        'reset_count',           reset_count,
        'reset_task_types',      reset_task_types,
        'failed_orchestrators',  failed_orchestrator_count,
        'cutoff_at',             cutoff
      ),
      now()
    );
  END IF;

  RETURN jsonb_build_object(
    'failed_orchestrators', failed_orchestrator_count,
    'reset',                reset_count,
    'reset_task_types',     reset_task_types,
    'cutoff',               cutoff
  );
END $$;

REVOKE ALL ON FUNCTION public.reap_dead_worker_jobs() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reap_dead_worker_jobs() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reap_dead_worker_jobs() TO service_role;

COMMENT ON FUNCTION public.reap_dead_worker_jobs() IS
  'Heartbeat-based reaper. Detects workers whose last_beat_at is >90s old and resets their claimed jobs (fail-closed for autopost_* orchestrators, reset-to-pending for everything else). Scheduled every minute via pg_cron job reap-dead-worker-jobs. Complementary to worker/src/lib/staleClaimReaper.ts which uses updated_at + 90-120min windows as a backstop.';

-- ── pg_cron schedule (every minute alongside autopost-tick + outbox sweeper) ──
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$ BEGIN
  BEGIN PERFORM cron.unschedule('reap-dead-worker-jobs');
  EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'reap-dead-worker-jobs',
  '* * * * *',
  $$ SELECT public.reap_dead_worker_jobs(); $$
);

COMMIT;
