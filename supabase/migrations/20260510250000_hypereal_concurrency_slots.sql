-- ============================================================
-- C-8-1 / Crash CRASH-002: fleet-wide Hypereal concurrency cap
-- ============================================================
--
-- WHY:
--   Per-instance Hypereal limiters (worker/src/services/imageGenerator.ts
--   acquireHypereal — cap 10) and the openrouter limiter (cap 2) only
--   coordinate within a single Node process. Render now runs up to 8
--   worker replicas; at launch load 8 × 10 = 80 simultaneous Hypereal
--   submissions on a single API key. Hypereal rate-limits per-KEY, not
--   per-instance, so the fleet's per-key budget is shredded into random
--   429s under coordinated traffic spikes.
--
--   This table is a fleet-wide token bucket: N rows == N concurrent
--   submission slots across ALL worker instances. A submission UPDATEs
--   one row from worker_id IS NULL → worker_id=$1 and RETURNINGs the
--   slot id; release nulls the worker_id again. If no row is free, the
--   acquire returns null and the caller falls back to a backoff loop
--   (the caller already has retry plumbing — withTransientRetry +
--   isTransientError handle the wait).
--
-- WHY 12 SLOTS:
--   Empirical: Hypereal honors ~10–15 concurrent submissions per key
--   before 429s start cascading. 12 leaves headroom for occasional
--   over-acquire from the reaper window (a stuck slot held for >5 min
--   becomes reclaimable, but the holder hasn't yet died from a worker
--   crash so for a brief sliver of time the effective concurrency can
--   exceed 12 by 1–2). Operationally we can SQL-UPDATE the row count
--   without code changes — INSERT or DELETE rows from this table to
--   re-cap, no migration needed.
--
-- REAPER:
--   Worker-side scan runs hourly with the existing stale-claim pattern
--   (worker/src/lib/staleClaimReaper.ts). Any slot held >5 min implies
--   the worker that took it died mid-submission (SIGTERM mid-Hypereal-
--   POST), so we forcibly release. Slot IDs survive across reaper runs
--   — we never DROP rows, we just NULL the worker_id.
--
-- NOT BUDGETED BY:
--   * Status polls (GET /v1/jobs/{id}) — those are cheap and run on
--     wide-open intervals; rate-limiting POLLS would starve submission
--     slots behind in-flight renders that already paid for their slot.
--     Only submissions (POST /v1/images/generate, /v1/videos/generate)
--     take a slot.
--   * The OpenRouter path — that's a different provider with its own
--     per-key budget. See worker/src/services/openrouter.ts for its
--     local limiter (cap=2). A second slots table would be added there
--     if/when OpenRouter starts replica-coordinating too.

CREATE TABLE IF NOT EXISTS public.hypereal_concurrency_slots (
  id          SMALLINT      PRIMARY KEY,
  worker_id   TEXT,         -- NULL = free; non-null = held
  acquired_at TIMESTAMPTZ,
  CONSTRAINT hypereal_slots_worker_id_acquired_at_paired CHECK (
    (worker_id IS NULL AND acquired_at IS NULL) OR
    (worker_id IS NOT NULL AND acquired_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.hypereal_concurrency_slots IS
  'Fleet-wide token bucket for Hypereal API submissions. One row per concurrent slot. See C-8-1 / migration 20260510250000_hypereal_concurrency_slots.sql.';

-- Seed 12 slots. Idempotent — re-running the migration is a no-op.
INSERT INTO public.hypereal_concurrency_slots (id, worker_id, acquired_at)
SELECT s, NULL, NULL FROM generate_series(1, 12) AS s
ON CONFLICT (id) DO NOTHING;

-- Index for the reaper's "held >5 min" scan. PARTIAL index keeps it
-- tiny — only rows currently held appear, free rows are excluded.
CREATE INDEX IF NOT EXISTS idx_hypereal_slots_acquired_at
  ON public.hypereal_concurrency_slots(acquired_at)
  WHERE acquired_at IS NOT NULL;

-- Lock down. service_role bypasses RLS, which is what the worker uses;
-- anon/authenticated have zero business reading or mutating this table.
ALTER TABLE public.hypereal_concurrency_slots ENABLE ROW LEVEL SECURITY;

-- No policies defined → all non-service-role access denied by default.

-- Revoke any default grants too, belt and braces.
REVOKE ALL ON public.hypereal_concurrency_slots FROM PUBLIC;
REVOKE ALL ON public.hypereal_concurrency_slots FROM anon;
REVOKE ALL ON public.hypereal_concurrency_slots FROM authenticated;
