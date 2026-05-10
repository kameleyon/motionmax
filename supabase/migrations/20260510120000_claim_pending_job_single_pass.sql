-- ============================================================================
-- claim_pending_job — single-pass FOR UPDATE SKIP LOCKED rewrite
-- ============================================================================
-- Closes B-NEW-18 / CRASH-001 / F-CH-02 / Stream C-2 from .audits/2026-05-10-360.
--
-- ── Why this migration ─────────────────────────────────────────────────────
-- Previous body (20260505110000_claim_pending_job_per_project_fairness.sql)
-- ran TWO correlated COUNT(*) subqueries per candidate row in the to_claim
-- CTE — once for `user_active_count`, once for `project_active_count`. With N
-- pending rows visible to the planner, every claim therefore did O(N) full
-- scans of the `processing` snapshot before applying ORDER BY ... LIMIT.
--
-- Documented incident: 2026-05-08 — backlog of ~250 pending across the
-- 8-instance fleet caused per-claim latency to climb from ~12ms (typical)
-- to ~600ms+, which compounded with the per-realtime-INSERT pollQueue
-- trigger to produce a self-reinforcing claim storm. Fleet briefly hit the
-- Supabase pooler connection ceiling.
--
-- ── Shape of the new body ──────────────────────────────────────────────────
-- 1. Compute the user/project in-flight counts ONCE in a CTE
--    (`active_counts`), grouping over the small `processing` set rather
--    than per candidate. PostgreSQL evaluates this CTE a single time.
-- 2. Pick claimable candidates with a SINGLE pass over the
--    `idx_video_generation_jobs_claimable` partial index, joining the
--    aggregate counts via LEFT JOIN. No correlated subquery anywhere.
-- 3. Apply ORDER BY (user_active, project_active, created_at) and
--    `LIMIT p_limit FOR UPDATE OF j SKIP LOCKED` exactly as before so
--    the fairness contract from 20260505110000 is preserved.
-- 4. UPDATE-RETURNING flips status='pending' → 'processing' atomically.
--
-- The dependency-gate semantics from 20260423210000 (treat any terminal
-- dep as "done waiting") are preserved verbatim.
--
-- ── Expected query plan (to verify on staging) ─────────────────────────────
-- Cannot run EXPLAIN ANALYZE from this migration file. On staging the
-- expected plan after this migration is approximately:
--
--   Update on video_generation_jobs j
--     ->  Hash Join
--           ->  Limit
--                 ->  LockRows  (FOR UPDATE OF j SKIP LOCKED)
--                       ->  Sort  (user_active ASC, project_active ASC,
--                                  created_at ASC)
--                             ->  Hash Left Join
--                                   ->  Index Scan using
--                                       idx_video_generation_jobs_claimable
--                                       on video_generation_jobs j
--                                       Index Cond: (status = 'pending')
--                                   ->  CTE Scan on active_counts_user
--                             ->  Hash Left Join
--                                   ->  CTE Scan on active_counts_project
--           ->  CTE Scan on to_claim
--
-- Critically, NO `SubPlan` / `CorrelatedSubquery` nodes anywhere — the
-- aggregates are computed once over `processing` rows, then joined.
-- Staging verification: pick a snapshot with ≥100 pending and run
--   EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM claim_pending_job(NULL,NULL,1,'staging-test');
-- Expect total time ≤ 5ms with the new index, vs 200-600ms before.

BEGIN;

-- ── Indexes ────────────────────────────────────────────────────────────────
-- Partial covering index for the pending-claim hot path. Status='pending' is
-- a tiny fraction of the table (most rows are 'completed'), so a partial
-- index keeps it small enough to stay hot in shared_buffers across the fleet.
--
-- We deliberately DO NOT use CREATE INDEX CONCURRENTLY here:
--   * Supabase migrations run inside an implicit transaction wrapper, and
--     CONCURRENTLY is forbidden inside a transaction (PG raises 25001).
--   * `video_generation_jobs` has hot writes; a non-CONCURRENT CREATE INDEX
--     takes an ACCESS EXCLUSIVE lock for the duration of the build.
--     Mitigation: the partial WHERE status IN (...) keeps the indexed set
--     in the low thousands at steady state, so the build typically completes
--     in <500ms even in production.
--   * If a future deploy-time check shows the build exceeds 2s on prod-size
--     data, run this CREATE INDEX manually OUT OF BAND with CONCURRENTLY
--     against the database, then mark this migration as already-applied.
--
-- Column order rationale: `status` first (most selective predicate by far —
-- partial filters to 'pending' only), `created_at` second (FIFO ORDER BY
-- tiebreaker), `user_id` and `project_id` included for cheap fairness-CTE
-- lookups without a heap visit. The note B-NEW-18 mentions "(status,
-- priority, created_at)" — there is no `priority` column on this table
-- (verified across all migrations as of 2026-05-10), so we omit it. If a
-- priority column is ever introduced, slot it between status and created_at.
CREATE INDEX IF NOT EXISTS idx_video_generation_jobs_claimable
  ON public.video_generation_jobs (status, created_at ASC)
  INCLUDE (user_id, project_id, task_type)
  WHERE status = 'pending';

-- Partial indexes that back the user/project fairness aggregates. These
-- are tiny (indexed set = currently-processing rows, capped fleet-wide by
-- MAX_CONCURRENT_JOBS × maxInstances ≈ 8 × 12 = ~100 rows). The CTE in
-- the function body groups over these instead of full-scanning the table.
CREATE INDEX IF NOT EXISTS idx_video_generation_jobs_processing_user
  ON public.video_generation_jobs (user_id)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_video_generation_jobs_processing_project
  ON public.video_generation_jobs (project_id)
  WHERE status = 'processing' AND project_id IS NOT NULL;

-- ── Function body ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_pending_job(
  p_task_type        TEXT    DEFAULT NULL,
  p_exclude_task_type TEXT   DEFAULT NULL,
  p_limit            INTEGER DEFAULT 1,
  p_worker_id        TEXT    DEFAULT NULL
)
RETURNS SETOF public.video_generation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  WITH
  -- One-shot aggregate over the (small) processing set. Replaces the
  -- per-candidate correlated COUNT(*) that drove the old O(N) cost.
  active_user AS (
    SELECT user_id, COUNT(*)::bigint AS user_active_count
    FROM public.video_generation_jobs
    WHERE status = 'processing'
    GROUP BY user_id
  ),
  active_project AS (
    SELECT project_id, COUNT(*)::bigint AS project_active_count
    FROM public.video_generation_jobs
    WHERE status = 'processing' AND project_id IS NOT NULL
    GROUP BY project_id
  ),
  to_claim AS (
    SELECT j.id
    FROM public.video_generation_jobs j
    LEFT JOIN active_user    au ON au.user_id    = j.user_id
    LEFT JOIN active_project ap ON ap.project_id = j.project_id
    WHERE j.status = 'pending'
      AND (p_task_type         IS NULL OR j.task_type =  p_task_type)
      AND (p_exclude_task_type IS NULL OR j.task_type <> p_exclude_task_type)
      -- Dependency gate: claim when every dep is in a terminal state
      -- (completed OR failed). Failed deps release dependents so
      -- finalize can produce a partial result instead of hanging.
      -- (Preserved verbatim from 20260423210000.)
      AND (
        j.depends_on = '{}'
        OR NOT EXISTS (
          SELECT 1 FROM public.video_generation_jobs dep
          WHERE dep.id = ANY(j.depends_on)
            AND dep.status NOT IN ('completed', 'failed')
        )
      )
    ORDER BY
      COALESCE(au.user_active_count,    0) ASC,    -- inter-user fairness
      COALESCE(ap.project_active_count, 0) ASC,    -- intra-user inter-project fairness
      j.created_at                         ASC     -- FIFO tiebreaker
    LIMIT p_limit
    FOR UPDATE OF j SKIP LOCKED
  )
  UPDATE public.video_generation_jobs j
  SET status = 'processing', updated_at = NOW(), worker_id = p_worker_id
  FROM to_claim
  WHERE j.id = to_claim.id
  RETURNING j.*;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_pending_job(TEXT, TEXT, INTEGER, TEXT) TO service_role;

COMMIT;
