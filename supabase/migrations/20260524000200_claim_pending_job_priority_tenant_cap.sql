-- ============================================================================
-- claim_pending_job — priority ordering + hard per-tenant (account) cap
-- ============================================================================
-- Supersedes the body authored in
-- 20260510120000_claim_pending_job_single_pass.sql. That migration killed the
-- O(N) correlated-subquery cost by computing the user/project in-flight counts
-- ONCE in CTEs and LEFT JOINing them. This migration PRESERVES that single-pass
-- shape verbatim (same signature, SECURITY DEFINER, search_path, grants,
-- depends_on gate, FOR UPDATE OF j SKIP LOCKED) and layers in two /api/v1
-- gateway requirements from MOTIONMAX_API_ROADMAP.md:
--
--   1. PRIORITY ORDERING.
--      Builder B added an integer `priority` column to video_generation_jobs
--      (higher = claim sooner). We read it directly off the candidate row and
--      make it the PRIMARY sort key — ORDER BY j.priority DESC first, THEN the
--      existing fairness columns (user_active_count ASC, project_active_count
--      ASC), THEN created_at ASC. No CTE is needed for priority because it is a
--      plain column already covered by the candidate scan; this keeps the plan
--      single-pass with no new correlated work.
--
--   2. HARD PER-TENANT (account) CAP.
--      Builder B added a nullable `account_id` column. A paying tenant must not
--      monopolize the fleet: each account may have at most `tenant_cap`
--      jobs in 'processing' at once, where the cap is tier-parameterized off
--      public.accounts.tier:
--          free    → 2
--          creator → 5
--          studio  → 12
--      Legacy browser jobs (account_id IS NULL) are NOT subject to any account
--      cap — their behavior is unchanged (user/project fairness only).
--
--      The cap is enforced WITHOUT a per-row correlated subquery: we compute
--      the per-account in-flight count ONCE in an `active_account` CTE (grouping
--      over the small 'processing' set, exactly like active_user/active_project),
--      LEFT JOIN it to candidates, LEFT JOIN public.accounts for the tier, and
--      filter `COALESCE(account_active_count,0) < tenant_cap` in the WHERE. This
--      reuses the COUNT-CTE join style and introduces no performance regression.
--
-- ── depends_on gate / SKIP LOCKED — preserved verbatim ─────────────────────
-- The dependency-gate semantics (claim only when every dep is terminal:
-- completed OR failed) and the `LIMIT p_limit FOR UPDATE OF j SKIP LOCKED`
-- atomic-claim behavior are carried over unchanged from 20260510120000.
--
-- ── Indexes ────────────────────────────────────────────────────────────────
-- The claimable / processing-user / processing-project partial indexes from
-- 20260510120000 are reused as-is. We add one tiny partial index backing the
-- new per-account aggregate (mirrors idx_video_generation_jobs_processing_user)
-- so the active_account CTE groups over an index, not a heap scan.
-- ============================================================================

BEGIN;

-- Partial index backing the per-account in-flight aggregate. Indexed set =
-- currently-processing rows that belong to an API account (account_id NOT NULL),
-- which is fleet-capped and tiny, so this stays hot in shared_buffers.
CREATE INDEX IF NOT EXISTS idx_video_generation_jobs_processing_account
  ON public.video_generation_jobs (account_id)
  WHERE status = 'processing' AND account_id IS NOT NULL;

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
  -- One-shot aggregates over the (small) processing set. Each is computed a
  -- single time and LEFT JOINed to candidates — never a per-row subquery.
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
  -- Per-tenant (account) in-flight count, computed once. Backs the hard cap.
  active_account AS (
    SELECT account_id, COUNT(*)::bigint AS account_active_count
    FROM public.video_generation_jobs
    WHERE status = 'processing' AND account_id IS NOT NULL
    GROUP BY account_id
  ),
  to_claim AS (
    SELECT j.id
    FROM public.video_generation_jobs j
    LEFT JOIN active_user    au ON au.user_id    = j.user_id
    LEFT JOIN active_project ap ON ap.project_id = j.project_id
    LEFT JOIN active_account aa ON aa.account_id = j.account_id
    -- Tier lookup for the per-account cap. LEFT JOIN so legacy rows with a
    -- NULL account_id (and any account_id that somehow lacks a row) fall
    -- through to the NULL-account branch of the cap predicate below.
    LEFT JOIN public.accounts acct ON acct.id = j.account_id
    WHERE j.status = 'pending'
      AND (p_task_type         IS NULL OR j.task_type =  p_task_type)
      AND (p_exclude_task_type IS NULL OR j.task_type <> p_exclude_task_type)
      -- Dependency gate: claim when every dep is in a terminal state
      -- (completed OR failed). Failed deps release dependents so
      -- finalize can produce a partial result instead of hanging.
      -- (Preserved verbatim from 20260423210000 / 20260510120000.)
      AND (
        j.depends_on = '{}'
        OR NOT EXISTS (
          SELECT 1 FROM public.video_generation_jobs dep
          WHERE dep.id = ANY(j.depends_on)
            AND dep.status NOT IN ('completed', 'failed')
        )
      )
      -- HARD per-tenant cap. Legacy browser jobs (account_id IS NULL) are
      -- exempt — their behavior is unchanged. API jobs are admitted only while
      -- the account is below its tier-parameterized in-flight cap.
      AND (
        j.account_id IS NULL
        OR COALESCE(aa.account_active_count, 0) <
           CASE acct.tier
             WHEN 'studio'  THEN 12
             WHEN 'creator' THEN 5
             WHEN 'free'    THEN 2
             ELSE 2   -- unknown/missing tier → most conservative cap
           END
      )
    ORDER BY
      j.priority                           DESC,    -- highest priority first
      COALESCE(au.user_active_count,    0) ASC,     -- inter-user fairness
      COALESCE(ap.project_active_count, 0) ASC,     -- intra-user inter-project fairness
      j.created_at                         ASC      -- FIFO tiebreaker
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
