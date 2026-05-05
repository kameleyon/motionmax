-- Switch the autopost topic queue from circular buffer → head-pop FIFO.
--
-- Old behaviour (20260428130000 autopost_resolve_topic):
--   fire_idx := COUNT(*) FROM autopost_runs WHERE schedule_id = ...
--   RETURN topic_pool[(fire_idx % pool_len) + 1]
-- Topics were NEVER removed from topic_pool — the index just cycled
-- modulo length. Three concrete failure modes:
--   1. Delete head topic (UI calls update topic_pool = topic_pool[2:])
--      → array shifts, pool_len decreases by 1, but fire_idx is the
--        same → picker now returns what was previously position N+1,
--        not "the new head" the user expected.
--   2. Drag topic from position 30 → 1 → array reorders, fire_idx
--      unchanged → picker still returns position 6 (or whatever
--      fire_idx % len lands on), ignoring the user's reorder.
--   3. After all topics fire once, the SAME topics cycle again
--      forever — no signal to the user that the queue is "drained."
--
-- New behaviour:
--   - autopost_resolve_topic always returns topic_pool[1] (the head)
--   - An AFTER INSERT trigger on autopost_runs pops topic_pool[1]
--     from the schedule's topic_pool the moment a run is created
--   - Empty pool → resolve_topic returns NULL (existing
--     empty-topic-pool guard in autopost_tick / autopost_fire_now
--     already handles this cleanly — it skips the run with a
--     RAISE NOTICE / 22023 error respectively)
--
-- Effect: topic_pool now behaves exactly as the UI presents it —
-- a FIFO queue. Deleting or reordering the head produces the
-- intuitive next-fire result. After all topics fire, the queue is
-- empty and the user is prompted to generate more (matching the
-- existing "Out of topics" UX in AutopostHome's per-row card).

-- ── 1. Rewrite the resolver ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.autopost_resolve_topic(schedule_row public.autopost_schedules)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF schedule_row.topic_pool IS NULL
     OR COALESCE(array_length(schedule_row.topic_pool, 1), 0) = 0 THEN
    RETURN NULL;
  END IF;
  -- Head of the FIFO queue. The dequeue happens in the AFTER INSERT
  -- trigger on autopost_runs (see autopost_pop_topic_after_run below)
  -- so this function stays read-only / STABLE.
  RETURN schedule_row.topic_pool[1];
END;
$$;

COMMENT ON FUNCTION public.autopost_resolve_topic(public.autopost_schedules)
  IS 'FIFO head-pop topic picker. Returns topic_pool[1] or NULL when empty. Dequeue happens in autopost_pop_topic_after_run trigger on autopost_runs INSERT.';


-- ── 2. AFTER INSERT trigger to pop the head ─────────────────────────
-- Why an AFTER INSERT trigger rather than inline mutation in
-- autopost_tick / autopost_fire_now: the trigger covers every code
-- path that creates a run row (cron tick, "Run now" RPC, future bulk
-- admin actions, retries, etc.) without needing each call site to
-- remember to dequeue. It's also atomic with the INSERT — there's no
-- moment when the run exists but the topic is still at the head.
--
-- Skips dequeue when:
--   - topic on the run is NULL (topicless run shouldn't happen post
--     the empty-pool guard, but defensive)
--   - the schedule's topic_pool head doesn't match the run's topic
--     (e.g. user reordered between resolve_topic and the trigger
--     firing — extremely unlikely in practice, but in that case
--     skipping the dequeue is safer than popping the wrong topic)
CREATE OR REPLACE FUNCTION public.autopost_pop_topic_after_run()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pool TEXT[];
BEGIN
  IF NEW.topic IS NULL OR NEW.schedule_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Lock the schedule row + read pool snapshot in one go to avoid
  -- the read-write race where two near-simultaneous runs both
  -- dequeue and end up popping the same head twice.
  SELECT topic_pool INTO v_pool
  FROM public.autopost_schedules
  WHERE id = NEW.schedule_id
  FOR UPDATE;

  IF v_pool IS NULL OR COALESCE(array_length(v_pool, 1), 0) = 0 THEN
    RETURN NEW;
  END IF;

  -- Defensive head-match check. If the user reordered between
  -- resolve_topic and run-insert (millisecond window), the head
  -- might no longer match what was fired — in that case leave the
  -- pool alone rather than removing the wrong topic.
  IF v_pool[1] IS DISTINCT FROM NEW.topic THEN
    RETURN NEW;
  END IF;

  UPDATE public.autopost_schedules
  SET topic_pool = v_pool[2:array_length(v_pool, 1)]
  WHERE id = NEW.schedule_id;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.autopost_pop_topic_after_run()
  IS 'AFTER INSERT trigger function: removes autopost_runs.topic from the head of autopost_schedules.topic_pool. Drives the head-pop FIFO semantics for the autopost queue.';

DROP TRIGGER IF EXISTS autopost_runs_pop_topic ON public.autopost_runs;

CREATE TRIGGER autopost_runs_pop_topic
  AFTER INSERT ON public.autopost_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.autopost_pop_topic_after_run();
