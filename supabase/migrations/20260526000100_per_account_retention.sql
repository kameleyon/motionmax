-- ============================================================
-- Per-account (per-tenant) result retention — Phase 4 (Builder B).
-- ============================================================
-- Roadmap §Phase 4 (Post-GA). Adds an OPT-IN, per-account override
-- of the global 30-day result-retention window introduced in Phase 3
-- (20260525000200_result_retention.sql).
--
--   accounts.retention_days
--     NULL  → inherit the global window (30d). The existing global
--             cron 'generated-videos-retention' remains AUTHORITATIVE
--             for these accounts; this migration does NOT touch them.
--     0     → zero-retention: the result asset is purged as soon as the
--             per-account cron next runs (no grace window). The read
--             path special-cases 0 → always 'expired'.
--     N>0   → retain N days from the job's created_at, then purge.
--
-- ── Why a job-driven purge (not a storage.objects → account JOIN) ──
-- The finished export object is written by the worker to bucket
-- 'videos' at path 'exports/export_<project_id>_<ts>.mp4'
-- (worker/src/handlers/export/storageHelpers.ts:265 uploadToSupabase →
-- BUCKET_NAME='videos', storagePath='exports/'||fileName). The object
-- KEY encodes project_id, NOT account_id or job_id, and a project is
-- NOT 1:1 with an account or a job. There is therefore NO robust,
-- collision-free way to attribute an arbitrary storage.objects row to a
-- single account purely from its path. Deleting by a path heuristic
-- could remove another tenant's asset — explicitly out of bounds for
-- this phase.
--
-- The SAFE attribution that DOES exist is the job row itself:
-- video_generation_jobs carries account_id (20260524000100) AND the
-- authoritative result URL (result.url / result.video_url /
-- result.finalUrl, or payload.finalUrl / payload.url — the same key
-- precedence the read path uses in api/v1/videos/[id]/index.ts
-- buildResult). cleanup_account_results() therefore walks the JOBS that
-- belong to accounts with a non-NULL retention_days, extracts the exact
-- (bucket, object-path) the job points at, and deletes ONLY those
-- specific objects once the account's window has elapsed. Every
-- deletion is keyed to one account's own job → it can never touch
-- another tenant's data.
--
-- NOTE (bucket spread): the API contract bucket name is
-- 'generated-videos' (api/v1/videos/[id]/index.ts RESULT_BUCKET), while
-- the current worker writes to 'videos'. cleanup_account_results()
-- parses the bucket OUT OF THE STORED URL itself rather than hard-coding
-- one, so it correctly purges whichever bucket the job's URL references
-- and remains correct if/when API jobs move to a dedicated bucket.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; CREATE OR REPLACE FUNCTION;
-- best-effort unschedule-then-schedule for the cron. BEGIN/COMMIT.
-- Timestamp 20260526000100 > latest prior migration 20260525000300.
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── 1. Per-account retention override column ─────────────────────────
-- NULL is the DEFAULT/INHERIT sentinel (global 30d via the existing
-- cron). 0 is a REAL value (zero-retention), so we must NOT coalesce it
-- away anywhere. A CHECK keeps the value sane (no negatives).
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS retention_days int;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_accounts_retention_days_nonneg'
      AND conrelid = 'public.accounts'::regclass
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT chk_accounts_retention_days_nonneg
      CHECK (retention_days IS NULL OR retention_days >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.accounts.retention_days IS
  'Per-account result-retention window in days for API video results. '
  'NULL = inherit the global 30-day window (handled by the global '
  '''generated-videos-retention'' cron). 0 = zero-retention (purge on '
  'next per-account-retention run). N>0 = retain N days from job '
  'created_at. Builder B / Phase 4.';

-- ── 2. Helper: parse the (bucket, object-path) out of a stored URL ───
-- Supabase storage URLs look like:
--   <base>/storage/v1/object/public/<bucket>/<path...>?<query>
--   <base>/storage/v1/object/sign/<bucket>/<path...>?token=...
--   <base>/storage/v1/object/<bucket>/<path...>
-- Returns NULL when the URL is not a recognisable storage object URL
-- (e.g. a third-party/provider URL) so the caller can skip it safely.
CREATE OR REPLACE FUNCTION public.api_storage_url_parts(p_url text)
RETURNS TABLE (bucket text, object_path text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_after text;
  v_slash int;
BEGIN
  IF p_url IS NULL OR p_url = '' THEN
    RETURN;
  END IF;

  -- Strip any query string (signed-URL token, cache-buster, etc.).
  p_url := split_part(p_url, '?', 1);

  -- Locate the storage object marker and take everything after it.
  -- Order matters: 'public/' and 'sign/' are more specific than the
  -- bare '/object/' form, so try them first.
  IF position('/storage/v1/object/public/' IN p_url) > 0 THEN
    v_after := split_part(p_url, '/storage/v1/object/public/', 2);
  ELSIF position('/storage/v1/object/sign/' IN p_url) > 0 THEN
    v_after := split_part(p_url, '/storage/v1/object/sign/', 2);
  ELSIF position('/storage/v1/object/' IN p_url) > 0 THEN
    v_after := split_part(p_url, '/storage/v1/object/', 2);
  ELSE
    RETURN; -- not a Supabase storage object URL
  END IF;

  IF v_after IS NULL OR v_after = '' THEN
    RETURN;
  END IF;

  -- v_after = '<bucket>/<path...>'. Split on the FIRST slash only; the
  -- object path itself may contain further slashes.
  v_slash := position('/' IN v_after);
  IF v_slash = 0 THEN
    RETURN; -- bucket with no object path → nothing to delete
  END IF;

  bucket      := left(v_after, v_slash - 1);
  object_path := substring(v_after FROM v_slash + 1);

  IF bucket IS NULL OR bucket = '' OR object_path IS NULL OR object_path = '' THEN
    RETURN;
  END IF;

  RETURN NEXT;
END;
$func$;

REVOKE ALL ON FUNCTION public.api_storage_url_parts(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.api_storage_url_parts(text) FROM anon;
REVOKE ALL ON FUNCTION public.api_storage_url_parts(text) FROM authenticated;

-- ── 3. Account-aware purge ───────────────────────────────────────────
-- Deletes the result objects of jobs that belong to accounts with a
-- non-NULL retention_days, once the job has aged past that account's
-- window. retention_days = 0 → any age qualifies (immediate purge on
-- the next run). NULL accounts are intentionally EXCLUDED here — the
-- global 30d cron stays authoritative for them.
--
-- Returns the number of storage.objects rows deleted (for cron logging /
-- observability). SECURITY DEFINER so the daily cron (running as the
-- function owner) can DELETE from storage.objects without a service key.
CREATE OR REPLACE FUNCTION public.cleanup_account_results()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_deleted int := 0;
BEGIN
  WITH candidate_jobs AS (
    -- One stored URL per job, using the SAME key precedence as the read
    -- path (api/v1/videos/[id]/index.ts buildResult). Only jobs whose
    -- owning account has an EXPLICIT retention_days are considered.
    SELECT
      j.id AS job_id,
      a.retention_days,
      j.created_at,
      COALESCE(
        NULLIF(j.result->>'url', ''),
        NULLIF(j.result->>'video_url', ''),
        NULLIF(j.result->>'finalUrl', ''),
        NULLIF(j.payload->>'finalUrl', ''),
        NULLIF(j.payload->>'url', '')
      ) AS stored_url
    FROM public.video_generation_jobs j
    JOIN public.accounts a
      ON a.id = j.account_id
    WHERE j.account_id IS NOT NULL
      AND a.retention_days IS NOT NULL
      AND j.status = 'completed'
  ),
  expired_jobs AS (
    -- Apply the per-account window. retention_days = 0 → every completed
    -- job with a stored URL qualifies immediately; N>0 → only those
    -- older than N days.
    SELECT cj.stored_url
    FROM candidate_jobs cj
    WHERE cj.stored_url IS NOT NULL
      AND (
        cj.retention_days = 0
        OR cj.created_at < (now() - (cj.retention_days || ' days')::interval)
      )
  ),
  targets AS (
    -- Resolve each stored URL to its concrete (bucket, object_path).
    -- DISTINCT so the same object referenced by multiple jobs is only
    -- targeted once.
    SELECT DISTINCT p.bucket, p.object_path
    FROM expired_jobs ej
    CROSS JOIN LATERAL public.api_storage_url_parts(ej.stored_url) p
  ),
  removed AS (
    DELETE FROM storage.objects o
    USING targets t
    WHERE o.bucket_id = t.bucket
      AND o.name      = t.object_path
    RETURNING o.id
  )
  SELECT count(*) INTO v_deleted FROM removed;

  RETURN v_deleted;
END;
$func$;

REVOKE ALL ON FUNCTION public.cleanup_account_results() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_account_results() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_account_results() FROM authenticated;

COMMENT ON FUNCTION public.cleanup_account_results() IS
  'Per-account result purge for the public API. Deletes storage objects '
  'referenced by completed video_generation_jobs whose owning account '
  'has an explicit accounts.retention_days, once the job has aged past '
  'that window (0 = immediate). Accounts with NULL retention_days are '
  'left to the global ''generated-videos-retention'' cron. Account-safe: '
  'every deletion is keyed to one account''s own job URL. Builder B / '
  'Phase 4.';

-- ── 4. Daily cron: per-account-retention ─────────────────────────────
-- Runs at 03:30 UTC, 30 min AFTER the global 'generated-videos-retention'
-- (03:00) so the two never contend and the global pass has already
-- cleared the NULL-retention backlog. Idempotent unschedule → schedule.
DO $$
BEGIN
  BEGIN
    PERFORM cron.unschedule('per-account-retention');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM cron.schedule(
    'per-account-retention',
    '30 3 * * *',
    $cmd$SELECT public.cleanup_account_results();$cmd$
  );
END $$;

COMMIT;
