-- Migration: admin_global_search RPC
--
-- Powers the upcoming Cmd+K command palette inside the admin dashboard.
-- A single SECURITY DEFINER RPC fans out an ilike substring search across
-- four domain tables and returns a unified, kind-discriminated result set
-- so the client can render heterogenous rows in one virtualized list.
--
-- Tables searched (verified against migration history, columns matched
-- exactly — no invention):
--   * profiles            (id, user_id, display_name, created_at)
--                         email lives in auth.users, joined via user_id.
--   * projects            (id, user_id, title, description, status, created_at)
--                         "name" does not exist on this schema; canonical
--                         label is `title`. Owner email joined via auth.users.
--   * video_generation_jobs (id, user_id, task_type, status, payload jsonb,
--                            error_message, created_at)
--                         No `prompt` column; we search id::text + task_type +
--                         payload::text (jsonb cast) which covers the
--                         prompt-bearing fields without requiring a schema
--                         change.
--   * api_call_logs       (id, user_id, provider, model, status, cost,
--                          total_duration_ms, created_at)
--                         The spec called this table `api_calls`; the
--                         actual table name in this codebase is
--                         api_call_logs. There is no `endpoint` column;
--                         provider+model fill that role.
--
-- Auth model: identical to admin_cancel_job_with_refund — auth.uid() must
-- be non-null AND public.is_admin(auth.uid()) must return true. Anything
-- else raises 42501. Empty/short queries (< 2 chars) short-circuit to an
-- empty set so a Cmd+K input firing on every keystroke can't hammer the
-- DB with full-table scans for "a".
--
-- No full-text indexes, no source-table mutations — pure read-side RPC.

CREATE OR REPLACE FUNCTION public.admin_global_search(
  q TEXT,
  limit_per_table INT DEFAULT 5
)
RETURNS TABLE (
  kind        TEXT,          -- 'user' | 'project' | 'generation' | 'api_call'
  id          UUID,
  title       TEXT,          -- canonical display label per row
  subtitle    TEXT,          -- secondary line (email / status / cost)
  created_at  TIMESTAMPTZ,
  rank        REAL           -- relevance for client-side sorting
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_pattern  TEXT;
  v_cap      INT;
BEGIN
  -- Admin gate — same shape as admin_cancel_job_with_refund.
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin_global_search: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin(v_admin_id) THEN
    RAISE EXCEPTION 'admin_global_search: forbidden'
      USING ERRCODE = '42501';
  END IF;

  -- Bail early on empty / 1-char queries so Cmd+K keystrokes don't
  -- trigger four full-table ilike scans.
  IF q IS NULL OR length(btrim(q)) < 2 THEN
    RETURN;
  END IF;

  -- Clamp limit_per_table to a sane range (defensive — caller is admin
  -- but the function is reused; large values would be an accidental DoS
  -- on the auth.users join).
  v_cap := GREATEST(1, LEAST(COALESCE(limit_per_table, 5), 50));

  v_pattern := '%' || btrim(q) || '%';

  RETURN QUERY
  WITH
    -- ── users ─────────────────────────────────────────────────────────
    -- Search auth.users.email (the canonical email source) and
    -- profiles.display_name. Title = email, subtitle = display_name.
    users_branch AS (
      SELECT
        'user'::TEXT                            AS kind,
        p.user_id                               AS id,
        COALESCE(u.email, p.user_id::text)      AS title,
        p.display_name                          AS subtitle,
        p.created_at                            AS created_at,
        CASE
          WHEN u.email ILIKE v_pattern         THEN 1.0::REAL
          WHEN p.display_name ILIKE v_pattern  THEN 0.8::REAL
          ELSE 0.5::REAL
        END                                     AS rank
      FROM public.profiles p
      LEFT JOIN auth.users u ON u.id = p.user_id
      WHERE u.email      ILIKE v_pattern
         OR p.display_name ILIKE v_pattern
      ORDER BY p.created_at DESC
      LIMIT v_cap
    ),

    -- ── projects ──────────────────────────────────────────────────────
    -- Schema has `title`, not `name`. Subtitle = owner email.
    projects_branch AS (
      SELECT
        'project'::TEXT                         AS kind,
        pr.id                                   AS id,
        pr.title                                AS title,
        u.email                                 AS subtitle,
        pr.created_at                           AS created_at,
        CASE
          WHEN pr.title ILIKE v_pattern        THEN 1.0::REAL
          WHEN pr.description ILIKE v_pattern  THEN 0.7::REAL
          ELSE 0.5::REAL
        END                                     AS rank
      FROM public.projects pr
      LEFT JOIN auth.users u ON u.id = pr.user_id
      WHERE pr.title       ILIKE v_pattern
         OR pr.description ILIKE v_pattern
      ORDER BY pr.created_at DESC
      LIMIT v_cap
    ),

    -- ── generations (video_generation_jobs) ───────────────────────────
    -- No `prompt` column in this schema; payload is JSONB. We match on
    -- id text, task_type, and a jsonb→text cast of payload so admins can
    -- find a job by partial UUID, by task type, or by anything embedded
    -- in the payload (script snippet, model name, etc).
    -- Subtitle = "<status> · <task_type>" so the operator sees state at
    -- a glance; the unified `created_at` column already carries timing.
    generations_branch AS (
      SELECT
        'generation'::TEXT                      AS kind,
        j.id                                    AS id,
        ('Job ' || left(j.id::text, 8))         AS title,
        (j.status || ' · ' || j.task_type)      AS subtitle,
        j.created_at                            AS created_at,
        CASE
          WHEN j.id::text ILIKE v_pattern       THEN 1.0::REAL
          WHEN j.task_type ILIKE v_pattern      THEN 0.8::REAL
          WHEN j.payload::text ILIKE v_pattern  THEN 0.6::REAL
          ELSE 0.5::REAL
        END                                     AS rank
      FROM public.video_generation_jobs j
      WHERE j.id::text       ILIKE v_pattern
         OR j.task_type      ILIKE v_pattern
         OR j.payload::text  ILIKE v_pattern
      ORDER BY j.created_at DESC
      LIMIT v_cap
    ),

    -- ── api_calls (api_call_logs) ─────────────────────────────────────
    -- Spec says "endpoint/model" — there is no endpoint column on this
    -- schema, so we search id, provider, and model. Subtitle exposes
    -- "<cost> · <duration_ms>ms" since those are the two operationally
    -- relevant fields when triaging an API call from Cmd+K.
    api_calls_branch AS (
      SELECT
        'api_call'::TEXT                        AS kind,
        a.id                                    AS id,
        (a.provider || ' / ' || a.model)        AS title,
        ('$' || COALESCE(a.cost, 0)::text
              || ' · '
              || COALESCE(a.total_duration_ms, 0)::text
              || 'ms')                          AS subtitle,
        a.created_at                            AS created_at,
        CASE
          WHEN a.id::text ILIKE v_pattern       THEN 1.0::REAL
          WHEN a.model ILIKE v_pattern          THEN 0.8::REAL
          WHEN a.provider ILIKE v_pattern       THEN 0.7::REAL
          ELSE 0.5::REAL
        END                                     AS rank
      FROM public.api_call_logs a
      WHERE a.id::text  ILIKE v_pattern
         OR a.provider  ILIKE v_pattern
         OR a.model     ILIKE v_pattern
      ORDER BY a.created_at DESC
      LIMIT v_cap
    )

  SELECT * FROM users_branch
  UNION ALL
  SELECT * FROM projects_branch
  UNION ALL
  SELECT * FROM generations_branch
  UNION ALL
  SELECT * FROM api_calls_branch
  ORDER BY created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_global_search(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_global_search(TEXT, INT) TO authenticated;

COMMENT ON FUNCTION public.admin_global_search(TEXT, INT)
IS 'Admin-only Cmd+K command-palette search. Substring-matches q (ilike) across profiles+auth.users, projects, video_generation_jobs, and api_call_logs, capped at limit_per_table per branch (default 5, max 50). Returns a unified (kind, id, title, subtitle, created_at, rank) shape sorted by created_at desc. Verifies is_admin(auth.uid()) at entry; returns empty when length(btrim(q)) < 2.';
