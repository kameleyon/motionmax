-- ─────────────────────────────────────────────────────────────────────────────
-- MotionMax Public API — Phase 2 — abuse controls + provider-slot attribution.
--
-- Two concerns, one migration (both are admin/worker-scoped escalation plumbing):
--
--   1. api_suspend_account / api_unsuspend_account — SECURITY DEFINER RPCs that
--      flip public.accounts.status and record the action in public.user_flags
--      (the existing admin-scoped moderation ledger). Service-role only — these
--      are called from the worker's future escalation job and from admin tools,
--      NEVER from the customer-authenticated gateway. Suspension is already
--      ENFORCED at auth time (apiKeyAuth.ts → 403 account_suspended); these RPCs
--      are the WRITE path that was previously missing.
--
--   2. hypereal_concurrency_slots.account_id — per-tenant ATTRIBUTION on the
--      fleet-wide provider-slot bucket so a HyperealSlotExhausted condition is
--      attributable to the tenant(s) holding the slots. This is NOT a second
--      hard cap (claim_pending_job already enforces the per-tenant in-flight cap
--      via account_id); it is soft reservation + observability. Nullable so the
--      reaper's NULL-on-release semantics are unchanged and legacy acquires
--      (no accountId threaded) still work.
--
-- Idempotent: safe to re-run (IF NOT EXISTS / CREATE OR REPLACE).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Provider-slot attribution column.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.hypereal_concurrency_slots
  ADD COLUMN IF NOT EXISTS account_id uuid;

-- Lets us answer "which tenant is monopolising the bucket?" without a scan
-- gymnastics. Partial index keeps it cheap (only held + attributed rows).
CREATE INDEX IF NOT EXISTS hypereal_concurrency_slots_account_id_idx
  ON public.hypereal_concurrency_slots (account_id)
  WHERE account_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. api_suspend_account(p_account_id, p_reason) → jsonb
--
-- Flips the account to 'suspended' and records a 'suspended' user_flags row
-- against the account owner. flagged_by is set to the owner's own user_id
-- (the user_flags table requires flagged_by NOT NULL and there is no stable
-- system uuid; attributing the system action to the owner keeps the FK-free
-- column populated and the moderation ledger self-consistent — the reason
-- text carries the "auto/system" provenance).
--
-- Returns {suspended:true, account_id, flag_id, already_suspended}.
-- Idempotent: a second call on an already-suspended account is a no-op on
-- accounts (status already 'suspended') but still records the flag so the
-- escalation history is complete; already_suspended reports the prior state.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_suspend_account(
  p_account_id uuid,
  p_reason     text DEFAULT 'policy_violation'
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_owner   uuid;
  v_prev    text;
  v_flag_id uuid;
  v_reason  text := COALESCE(NULLIF(btrim(p_reason), ''), 'policy_violation');
BEGIN
  SELECT owner_user_id, status
    INTO v_owner, v_prev
    FROM public.accounts
   WHERE id = p_account_id
   FOR UPDATE;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'api_suspend_account: account not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.accounts
     SET status = 'suspended'
   WHERE id = p_account_id;

  INSERT INTO public.user_flags (user_id, flag_type, reason, details, flagged_by)
  VALUES (
    v_owner,
    'suspended',
    v_reason,
    'Account ' || p_account_id::text || ' suspended via api_suspend_account.',
    v_owner
  )
  RETURNING id INTO v_flag_id;

  RETURN jsonb_build_object(
    'suspended',         true,
    'account_id',        p_account_id,
    'flag_id',           v_flag_id,
    'already_suspended', (v_prev = 'suspended')
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.api_suspend_account(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.api_suspend_account(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.api_suspend_account(uuid, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. api_unsuspend_account(p_account_id) → jsonb  (symmetry / reinstatement)
--
-- Flips the account back to 'active' and resolves any open (unresolved)
-- 'suspended' flags for the owner so the moderation ledger reflects the
-- reinstatement. Returns {suspended:false, account_id, resolved_flags}.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_unsuspend_account(
  p_account_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_owner    uuid;
  v_resolved int := 0;
BEGIN
  SELECT owner_user_id
    INTO v_owner
    FROM public.accounts
   WHERE id = p_account_id
   FOR UPDATE;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'api_unsuspend_account: account not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.accounts
     SET status = 'active'
   WHERE id = p_account_id;

  WITH resolved AS (
    UPDATE public.user_flags
       SET resolved_at       = now(),
           resolved_by       = v_owner,
           resolution_notes  = 'Account reinstated via api_unsuspend_account.',
           updated_at        = now()
     WHERE user_id   = v_owner
       AND flag_type = 'suspended'
       AND resolved_at IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_resolved FROM resolved;

  RETURN jsonb_build_object(
    'suspended',      false,
    'account_id',     p_account_id,
    'resolved_flags', v_resolved
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.api_unsuspend_account(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.api_unsuspend_account(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.api_unsuspend_account(uuid) TO service_role;

COMMIT;
