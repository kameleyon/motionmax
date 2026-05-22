-- ============================================================
-- Restore the `authenticated` SELECT grant on api_call_logs.
-- ============================================================
-- Regression source: 20260510280000_rls_public_leak_audit.sql ran
--   REVOKE ALL ON public.api_call_logs FROM anon, authenticated, PUBLIC;
-- to stop `anon` from reading finops data. That correctly locked out
-- anon, but it ALSO revoked the `authenticated` role's table-level
-- grant — which the admin console relies on. Three admin queries hit
-- api_call_logs directly:
--   * src/components/admin/_shared/useAdminLiveCounters.ts (MTD spend)
--   * src/lib/adminDirectQueries.ts (cost enrichment + API-call viewer)
-- Since 2026-05-10 every one of those has thrown
--   42501: permission denied for table api_call_logs
--
-- Why this is safe:
-- A table-level GRANT and an RLS policy are two independent gates.
-- 42501 fires at the GRANT gate, BEFORE RLS is evaluated — so the
-- existing `api_logs_select` policy (USING public.is_admin(auth.uid()))
-- never even gets a chance to filter. Restoring the grant lets the
-- request reach RLS; a non-admin authenticated user passes the grant
-- check but RLS returns 0 rows. Only admins see data.
--
-- anon stays fully locked out: no grant here + the existing RESTRICTIVE
-- policy `api_logs_deny_anon`. service_role keeps its full grant from
-- the 2026-05-10 migration. INSERT/UPDATE/DELETE remain service_role
-- only — the worker writes logs, the frontend only reads.
-- ============================================================

BEGIN;

GRANT SELECT ON public.api_call_logs TO authenticated;

COMMIT;
