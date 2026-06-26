-- ─────────────────────────────────────────────────────────────────────────────
-- MotionMax Public API — Phase 3 — spend caps + credit_transactions CHECK fix.
--
-- Three concerns, one migration (all billing-correctness for the public API):
--
--   1. LATENT BUG FIX: the credit_transactions.transaction_type CHECK constraint
--      is MISSING 'api_generation' — the value the gateway
--      (api/v1/videos/index.ts → deduct_credits_securely) ALREADY inserts on
--      every live API deduction. Today every billed API request fails the
--      ledger INSERT. Drop+recreate the constraint preserving ALL existing
--      values and adding 'api_generation'.
--
--   2. SPEND CAPS: nullable monthly_spend_cap_credits on public.accounts
--      (NULL = unlimited) and an optional per-key spend_cap_credits on
--      public.api_keys (NULL = inherit/unlimited). The gateway enforces the
--      account cap at submit time (Phase 3 Billing GA: "Per-key spend caps").
--
--   3. api_account_spend_mtd(p_account_id) — month-to-date API spend (credits)
--      for an account = -sum(amount) of this calendar month's 'api_generation'
--      transactions for the account owner. Used by the gateway cap check and by
--      any usage/reporting surface. SECURITY DEFINER, service_role only.
--
-- Idempotent: safe to re-run (DROP CONSTRAINT IF EXISTS / IF NOT EXISTS /
-- CREATE OR REPLACE). Latest prior migration = 20260524000600; this is the
-- first Phase 3 timestamp (> that).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Fix the credit_transactions.transaction_type CHECK constraint.
--
-- The inline constraint Postgres generates is credit_transactions_transaction_type_check
-- (see 20260419000009). Drop + recreate, preserving every existing allowed value
-- and ADDING 'api_generation'. This unblocks live API credit deductions which
-- the gateway already attempts with p_transaction_type := 'api_generation'.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_transaction_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'purchase',
    'usage',
    'generation',
    'video_generation',
    'subscription_grant',
    'refund',
    'refund_clawback',
    'adjustment',
    'signup_bonus',
    'daily_bonus',
    'api_generation'
  ));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Spend-cap columns.
--
-- monthly_spend_cap_credits on accounts: NULL = unlimited. When set, the gateway
-- refuses a submit when (month-to-date API spend + this request's credits) would
-- exceed the cap (402 spend_cap_exceeded).
--
-- spend_cap_credits on api_keys: optional per-key override (NULL = inherit the
-- account cap / unlimited). Reserved for finer-grained limits; enforcement of
-- the account-level cap ships in this phase.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS monthly_spend_cap_credits int;

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS spend_cap_credits int;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. api_account_spend_mtd(p_account_id) → int
--
-- Month-to-date API credit spend for an account. API deductions are recorded as
-- credit_transactions rows with transaction_type='api_generation' and a NEGATIVE
-- amount (deduct_credits_securely subtracts from the balance and logs the spend
-- as a negative delta). Spend = -sum(amount) so the result is a positive credit
-- count. Scoped to the calendar month (date_trunc('month', now())) and to the
-- account OWNER (credits are per-user; account→user via accounts.owner_user_id).
--
-- SECURITY DEFINER so the gateway's service-role client can call it; pinned
-- search_path; service_role only (not customer-authenticated authenticated/anon).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_account_spend_mtd(
  p_account_id uuid
)
RETURNS int
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_owner uuid;
  v_spend bigint;
BEGIN
  SELECT owner_user_id
    INTO v_owner
    FROM public.accounts
   WHERE id = p_account_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'api_account_spend_mtd: account not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(-SUM(amount), 0)
    INTO v_spend
    FROM public.credit_transactions
   WHERE user_id          = v_owner
     AND transaction_type = 'api_generation'
     AND created_at      >= date_trunc('month', now());

  -- Clamp to >= 0 (a stray positive 'api_generation' adjustment must not produce
  -- a negative MTD spend) and to int range for the caller's arithmetic.
  RETURN GREATEST(v_spend, 0)::int;
END;
$func$;

REVOKE ALL ON FUNCTION public.api_account_spend_mtd(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.api_account_spend_mtd(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.api_account_spend_mtd(uuid) TO service_role;

COMMIT;
