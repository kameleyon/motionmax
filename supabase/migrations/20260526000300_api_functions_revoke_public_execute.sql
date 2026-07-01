-- ============================================================================
-- api_functions_revoke_public_execute — lock down EXECUTE on API RPCs
-- ============================================================================
-- SECURITY HARDENING (applied to production 2026-07-01).
--
-- WHY (the vulnerability this closes):
--   The earlier API migrations created SECURITY DEFINER functions and tried to
--   restrict them with `REVOKE ... FROM anon`. That is NOT sufficient: Postgres
--   grants EXECUTE to the PUBLIC pseudo-role by DEFAULT on every new function,
--   and `REVOKE FROM anon` does not remove the PUBLIC grant. Because anon and
--   authenticated both inherit PUBLIC, any unauthenticated caller could still
--   EXECUTE these functions through PostgREST.
--
--   The high-severity cases were api_suspend_account / api_unsuspend_account:
--   as SECURITY DEFINER functions with no auth.uid() self-guard, an anon caller
--   could suspend or unsuspend ANY account. Supabase's own advisor flagged 36
--   of these as WARN.
--
-- WHAT this does:
--   1. REVOKE EXECUTE ... FROM PUBLIC on every API function (removes the
--      implicit inheritance path for anon + authenticated).
--   2. Explicitly GRANT EXECUTE to the roles each function is actually meant
--      for:
--        Group A — authenticated + service_role (user-facing read RPCs)
--        Group B — authenticated (owner/member self-service, self-guarded)
--        Group C — service_role ONLY (privileged / worker-internal RPCs)
--
-- Verified post-apply with has_function_privilege(): every Group C RPC returns
-- anon=false / authenticated=false / service_role=true.
--
-- Idempotent: REVOKE/GRANT are declarative and safe to re-run.
-- ============================================================================

-- ── Group A: authenticated + service_role (user-facing read RPCs) ──────────
REVOKE EXECUTE ON FUNCTION public.api_usage_summary   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_spend_breakdown FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.api_usage_summary   TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.api_spend_breakdown TO authenticated, service_role;

-- ── Group B: authenticated (owner/member self-service, self-guarded) ───────
REVOKE EXECUTE ON FUNCTION public.api_assert_account_owner        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_assert_account_owner_strict FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_create_key                  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_rotate_key                  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_revoke_key                  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_get_webhook_secret          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_add_member                  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_remove_member               FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_list_members                FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.api_assert_account_owner        TO authenticated;
GRANT  EXECUTE ON FUNCTION public.api_assert_account_owner_strict TO authenticated;
GRANT  EXECUTE ON FUNCTION public.api_create_key                  TO authenticated;
GRANT  EXECUTE ON FUNCTION public.api_rotate_key                  TO authenticated;
GRANT  EXECUTE ON FUNCTION public.api_revoke_key                  TO authenticated;
GRANT  EXECUTE ON FUNCTION public.api_get_webhook_secret          TO authenticated;
GRANT  EXECUTE ON FUNCTION public.api_add_member                  TO authenticated;
GRANT  EXECUTE ON FUNCTION public.api_remove_member               TO authenticated;
GRANT  EXECUTE ON FUNCTION public.api_list_members                TO authenticated;

-- ── Group C: service_role ONLY (privileged / worker-internal RPCs) ─────────
REVOKE EXECUTE ON FUNCTION public.api_key_touch            FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_check_rate_limit     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_rate_limit_purge     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_suspend_account      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_unsuspend_account    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_webhook_deliveries FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_requeue_dead_letter  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_account_spend_mtd    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.api_storage_url_parts    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_account_results  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.api_key_touch            TO service_role;
GRANT  EXECUTE ON FUNCTION public.api_check_rate_limit     TO service_role;
GRANT  EXECUTE ON FUNCTION public.api_rate_limit_purge     TO service_role;
GRANT  EXECUTE ON FUNCTION public.api_suspend_account      TO service_role;
GRANT  EXECUTE ON FUNCTION public.api_unsuspend_account    TO service_role;
GRANT  EXECUTE ON FUNCTION public.claim_webhook_deliveries TO service_role;
GRANT  EXECUTE ON FUNCTION public.api_requeue_dead_letter  TO service_role;
GRANT  EXECUTE ON FUNCTION public.api_account_spend_mtd    TO service_role;
GRANT  EXECUTE ON FUNCTION public.api_storage_url_parts    TO service_role;
GRANT  EXECUTE ON FUNCTION public.cleanup_account_results  TO service_role;
