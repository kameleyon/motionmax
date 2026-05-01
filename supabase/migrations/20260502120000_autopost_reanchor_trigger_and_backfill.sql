-- ============================================================
-- DB-level safeguards for autopost_schedules:
--
--   1. BEFORE UPDATE trigger that re-anchors next_fire_at when
--      active flips false → true. Mirrors what _AutomationCard's
--      toggle mutation does client-side (nextFireFromCron). Without
--      this trigger, a direct SQL UPDATE (admin tool, future
--      migration, raw psql) that flips active=true while
--      next_fire_at is in the past would still allow the
--      catch-up-storm scenario the no-catchup tick mitigates.
--      autopost_tick already clamps via GREATEST(...) but the
--      defense-in-depth value of forcing next_fire_at strictly
--      forward at the schedule layer is worth the 0.5 h.
--
--   2. config_snapshot backfill for older rows where the column
--      was added after row creation. Builds a snapshot from the
--      live columns so credit estimation, edit-modal hydration, and
--      worker-pipeline fallbacks all have a consistent surface.
--
--   3. cleanup_old_generate_topics_jobs(): deletes completed
--      generate_topics rows older than 7 days. The intake-form
--      polls these rows for ~60s; once the topic candidates are
--      extracted into the schedule's topic_pool the row has no
--      further purpose. Scheduled via pg_cron at the bottom of
--      this file so the table doesn't grow without bound.
-- ============================================================

-- ---------------------------------------------------------------
-- 1. autopost_schedules_reanchor_next_fire_at trigger
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.autopost_schedule_reanchor()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only re-anchor on the active false → true flip. Re-anchoring on
  -- every UPDATE would clobber the planner's own UPDATE that advances
  -- next_fire_at after a successful tick.
  IF TG_OP = 'UPDATE'
     AND NEW.active = TRUE
     AND COALESCE(OLD.active, FALSE) = FALSE
  THEN
    -- If next_fire_at is in the past, push it forward to the next
    -- valid cron slot strictly after NOW. Leave already-future
    -- next_fire_at values alone — those came from a deliberate set.
    IF NEW.next_fire_at IS NULL OR NEW.next_fire_at <= NOW() THEN
      BEGIN
        NEW.next_fire_at := public.autopost_advance_next_fire(
          NEW.cron_expression,
          NOW(),
          COALESCE(NEW.timezone, 'UTC')
        );
      EXCEPTION WHEN OTHERS THEN
        -- If the cron expression is malformed, fall back to NOW + 1m
        -- so the row is still consistent (active=true with a future
        -- cursor). A subsequent tick will surface the real cron error.
        NEW.next_fire_at := NOW() + INTERVAL '1 minute';
        RAISE NOTICE 'autopost_schedule_reanchor: cron parse failed for schedule %, fallback to NOW+1m: %',
          NEW.id, SQLERRM;
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.autopost_schedule_reanchor()
  IS 'BEFORE UPDATE trigger: when active flips false→true, push a stale next_fire_at strictly into the future via autopost_advance_next_fire. Defense-in-depth against catch-up storms.';

DROP TRIGGER IF EXISTS autopost_schedules_reanchor_trg ON public.autopost_schedules;
CREATE TRIGGER autopost_schedules_reanchor_trg
  BEFORE UPDATE ON public.autopost_schedules
  FOR EACH ROW
  EXECUTE FUNCTION public.autopost_schedule_reanchor();


-- ---------------------------------------------------------------
-- 2. config_snapshot backfill (one-shot, idempotent)
--
-- Older schedules predate the config_snapshot column. The worker
-- (handleAutopostRun) already falls back to defaults when the
-- snapshot is absent, but credit estimation in autopost_tick reads
-- mode + length from the snapshot, and a NULL snapshot would always
-- compute the smartflow/short floor. Build a minimal snapshot from
-- the live columns so existing schedules charge the right amount.
-- ---------------------------------------------------------------
UPDATE public.autopost_schedules
   SET config_snapshot = jsonb_build_object(
     'mode',             'smartflow',
     'length',           'short',
     'format',           'landscape',
     'style',            'realistic',
     'language',         NULL,
     'voice_type',       'standard',
     'voice_id',         NULL,
     'voice_name',       NULL,
     'duration_seconds', duration_seconds,
     'motion_preset',    motion_preset,
     'resolution',       resolution,
     'caption_template', caption_template,
     'hashtags',         to_jsonb(COALESCE(hashtags, ARRAY[]::TEXT[])),
     'intake_settings',  '{}'::jsonb
   )
 WHERE config_snapshot IS NULL;


-- ---------------------------------------------------------------
-- 3. cleanup_old_generate_topics_jobs
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_old_generate_topics_jobs()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  rows_deleted INT;
BEGIN
  DELETE FROM public.video_generation_jobs
   WHERE task_type = 'generate_topics'
     AND status = 'completed'
     AND created_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS rows_deleted = ROW_COUNT;
  RETURN rows_deleted;
END;
$$;

COMMENT ON FUNCTION public.cleanup_old_generate_topics_jobs()
  IS 'Daily cleanup: deletes generate_topics video_generation_jobs rows older than 7 days. Their result is consumed by the intake form within ~60s; rows live on only as queue clutter.';

GRANT EXECUTE ON FUNCTION public.cleanup_old_generate_topics_jobs() TO service_role;

-- Register the daily cleanup with pg_cron. Idempotent: drop then re-add.
DO $cron_register$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'autopost-generate-topics-cleanup') THEN
    PERFORM cron.unschedule('autopost-generate-topics-cleanup');
  END IF;
  -- Daily at 03:15 UTC — well outside the daily-summary 09:00 UTC window
  -- and the autopost-tick per-minute job.
  PERFORM cron.schedule(
    'autopost-generate-topics-cleanup',
    '15 3 * * *',
    $cron$select cleanup_old_generate_topics_jobs();$cron$
  );
EXCEPTION WHEN undefined_function OR undefined_table THEN
  RAISE NOTICE 'pg_cron not available, skipping autopost-generate-topics-cleanup registration';
END;
$cron_register$;
