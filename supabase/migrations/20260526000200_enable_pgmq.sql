-- ============================================================================
-- enable_pgmq — Post-GA queue-isolation SUBSTRATE (scaffold only, NOT wired)
-- ============================================================================
-- MOTIONMAX_API_ROADMAP.md §Phase 4 (Post-GA infra).
--
-- WHY (the problem this prepares for):
--   The /api/v1 ingestion path enqueues jobs by INSERTing into
--   public.video_generation_jobs, and the worker fleet claims them with the
--   claim_pending_job() RPC (FOR UPDATE ... SKIP LOCKED). Both sit on the same
--   OLTP Postgres instance that serves every browser request, every status
--   poll, and every dashboard query. At launch load that shared instance is the
--   single point of failure (SPOF) and the connection-pooler ceiling
--   (~60 upstream conns) is the throughput ceiling for the whole product
--   (see worker/src/lib/supabase.ts:91 — C-8-3 / CRASH-004). A noisy ingestion
--   spike can starve interactive traffic, and vice-versa.
--
--   pgmq (Postgres Message Queue) gives us a dedicated, durably-persisted queue
--   with archive/visibility-timeout semantics, so ingestion enqueue/claim can be
--   moved OFF the hot OLTP read/write path and (later) onto an isolated DB role
--   or even an isolated Postgres instance. This migration ONLY installs the
--   substrate so the seam exists; it changes NO runtime behavior.
--
-- WHAT THIS MIGRATION DOES:
--   * CREATE EXTENSION pgmq (idempotent).
--   * Create a single durable queue named 'ingestion', guarded so re-apply is a
--     no-op (pgmq.create errors if the queue already exists, so we swallow it).
--   * GRANT USAGE on the pgmq schema + EXECUTE on the send/read/delete/archive
--     functions to service_role (the only role the worker + API use).
--
-- WHAT THIS MIGRATION DOES *NOT* DO (deferred + flagged):
--   * It does NOT enqueue or claim anything. The table queue
--     (public.video_generation_jobs + claim_pending_job) stays 100% authoritative.
--   * enqueue/claim wiring lives behind the 'ingestion_pgmq' feature flag
--     (worker/src/lib/featureFlags.ts, default FALSE). See
--     worker/src/lib/ingestionQueue.ts for the no-op-when-off scaffold and
--     docs/api/queue-isolation.md for the cutover + rollback plan.
--
-- Idempotent + safe to re-run. SECURITY-sensitive grants are scoped to
-- service_role only (no anon / authenticated access to the raw queue).
-- ============================================================================

BEGIN;

-- Everything below is guarded on pgmq being AVAILABLE on this instance. A bare
-- `CREATE EXTENSION IF NOT EXISTS pgmq` would still RAISE (and abort the whole
-- migration run) if pgmq is not on pg_available_extensions. Since this is a
-- flag-OFF substrate scaffold that nothing reads yet, a missing pgmq must be a
-- clean skip, not a deploy failure. The grants reference schema pgmq, so they
-- too must live inside the guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgmq') THEN
    RAISE NOTICE 'pgmq is not available on this Postgres instance — skipping the queue-isolation substrate. The scaffold is flag-OFF so there is no runtime impact. Enable pgmq on the project (dashboard → Database → Extensions) and re-run to install it.';
    RETURN;
  END IF;

  -- 1) Install the extension (idempotent).
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgmq';

  -- 2) Create the 'ingestion' queue exactly once. pgmq.create() raises if the
  --    queue already exists, so guard re-apply by swallowing duplicate-object.
  BEGIN
    PERFORM pgmq.create('ingestion');
  EXCEPTION
    WHEN duplicate_table OR duplicate_object THEN
      RAISE NOTICE 'pgmq queue "ingestion" already exists; skipping create.';
    WHEN others THEN
      IF SQLERRM ILIKE '%already exists%' THEN
        RAISE NOTICE 'pgmq queue "ingestion" already exists (by message); skipping create.';
      ELSE
        RAISE;
      END IF;
  END;

  -- 3) Grants — service_role is the ONLY role that touches the queue (worker +
  --    API both run as service_role). No anon/authenticated access.
  EXECUTE 'GRANT USAGE ON SCHEMA pgmq TO service_role';
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO service_role';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO service_role';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgmq TO service_role';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA pgmq GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA pgmq GRANT USAGE, SELECT ON SEQUENCES TO service_role';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA pgmq GRANT EXECUTE ON FUNCTIONS TO service_role';
END;
$$;

COMMIT;
