-- ============================================================
-- Admin rebuild — Phase 2.8 + 2.9: auth helpers + audit hardening
-- ============================================================
-- WHAT (Phase 2.8 — Auth helpers):
--   * Extend app_role enum with 'super_admin'.
--   * Add public.is_super_admin(uuid) RETURNS boolean.
--   * Add public.current_admin_id() RETURNS uuid STABLE.
--
-- WHAT (Phase 2.9 — Unified audit log hardening):
--   * Add admin_logs.request_id text column (nullable; backfill NULL).
--   * Indexes on (admin_id, created_at desc), (action, created_at desc),
--     (target_id) WHERE target_id IS NOT NULL.
--   * Add admin_logs to supabase_realtime publication so the
--     Recent Actions popover updates without polling.
--
-- WHY:  super_admin gate is required for the most destructive
--       RPCs (force signout, hard delete, master kill switch,
--       newsletter cancel-in-flight). current_admin_id is used
--       inside RLS join policies (returns NULL for non-admins
--       so a USING clause naturally fails closed). request_id
--       allows correlation across multi-step admin workflows.
--
-- IMPLEMENTS: ADMIN_REBUILD_CHECKLIST.md sections 2.8 + 2.9.
-- ============================================================

BEGIN;

-- ============================================================
-- Phase 2.8 — Auth helpers
-- ============================================================

-- ── 1. Extend app_role enum with 'super_admin' ───────────────
-- ALTER TYPE ... ADD VALUE is not transactional in older
-- Postgres versions, but Supabase ships >= 14 where it is. We
-- still wrap it with IF NOT EXISTS for re-run safety.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'app_role' AND e.enumlabel = 'super_admin'
  ) THEN
    ALTER TYPE public.app_role ADD VALUE 'super_admin';
  END IF;
END;
$$;

-- ── 2. is_super_admin(uuid) — same shape as is_admin ─────────
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = 'super_admin'
  )
$$;

REVOKE ALL    ON FUNCTION public.is_super_admin(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_super_admin(uuid) TO authenticated, service_role;

-- ── 3. current_admin_id() — used inside RLS join policies ────
-- Returns auth.uid() if the caller is an admin, else NULL. RLS
-- USING clauses that join on this naturally fail closed for
-- non-admins (NULL = anything is NULL is false).
CREATE OR REPLACE FUNCTION public.current_admin_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN public.is_admin(auth.uid()) THEN auth.uid()
    ELSE NULL
  END
$$;

REVOKE ALL     ON FUNCTION public.current_admin_id() FROM anon;
GRANT  EXECUTE ON FUNCTION public.current_admin_id() TO authenticated, service_role;

-- ============================================================
-- Phase 2.9 — Unified audit log hardening
-- ============================================================

-- ── 4. admin_logs.request_id text column ─────────────────────
ALTER TABLE public.admin_logs
  ADD COLUMN IF NOT EXISTS request_id text;

COMMENT ON COLUMN public.admin_logs.request_id IS
  'Opaque correlation id stamped by the calling client / edge fn so a multi-step admin workflow (e.g. open thread + send message + close) groups in audit-log views.';

-- ── 5. Performance indexes on admin_logs ─────────────────────
CREATE INDEX IF NOT EXISTS admin_logs_admin_id_created_at_idx
  ON public.admin_logs (admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_logs_action_created_at_idx
  ON public.admin_logs (action, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_logs_target_id_idx
  ON public.admin_logs (target_id)
  WHERE target_id IS NOT NULL;

-- ── 6. Add admin_logs to supabase_realtime publication ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_logs;
  EXCEPTION WHEN OTHERS THEN
    -- already in the publication; nothing to do
    NULL;
  END;
END;
$$;

COMMIT;
