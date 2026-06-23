-- ─────────────────────────────────────────────────────────────────────────────
-- MotionMax Public API — Phase 2: customer webhook deliveries.
--
-- Per-job customer webhooks (video_generation_jobs.callback_url, validated at
-- submit by checkWebhookUrl()) are delivered by the worker on terminal
-- transitions (video.succeeded / video.failed). This migration adds:
--
--   public.webhook_deliveries  — outbox of webhook attempts (one row per job
--                                terminal event), with retry bookkeeping.
--   public.accounts.webhook_secret — per-account HMAC-SHA256 signing secret;
--                                backfilled for existing accounts and defaulted
--                                for new rows.
--   public.api_get_webhook_secret(p_account_id) — owner-only RPC that returns
--                                the secret (asserts ownership); the secret is
--                                deliberately NOT exposed via any broad view.
--
-- This is DISTINCT from public.admin_webhooks (admin-scoped, zero customer
-- consumers) and from public.job_results (the 'completed' outbox sweeper).
--
-- Idempotent: safe to re-run. RLS FORCE: account owner SELECTs own rows;
-- service_role full; anon denied.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. accounts.webhook_secret — per-account HMAC secret.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS webhook_secret text
    NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex');

-- Backfill any rows that somehow carry an empty secret (e.g. a future
-- migration that dropped the default). The column default already covers
-- both existing rows (added with the DEFAULT applied) and new inserts.
UPDATE public.accounts
   SET webhook_secret = encode(gen_random_bytes(24), 'hex')
 WHERE webhook_secret IS NULL OR webhook_secret = '';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. webhook_deliveries
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid,
  job_id          uuid REFERENCES public.video_generation_jobs(id) ON DELETE CASCADE,
  url             text NOT NULL,
  event           text NOT NULL CHECK (event IN ('video.succeeded', 'video.failed')),
  payload         jsonb,
  signature       text,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 6,
  response_code   int,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);

-- Due-row claim index: the dispatcher scans rows that are still in flight
-- (pending/delivering) and due (next_attempt_at <= now()). Partial index keeps
-- the working set tiny once rows settle into delivered/failed.
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON public.webhook_deliveries (status, next_attempt_at)
  WHERE status IN ('pending', 'delivering');

CREATE INDEX IF NOT EXISTS webhook_deliveries_account_id_idx
  ON public.webhook_deliveries (account_id);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_deliveries_owner_select ON public.webhook_deliveries;
DROP POLICY IF EXISTS webhook_deliveries_service_all  ON public.webhook_deliveries;
DROP POLICY IF EXISTS webhook_deliveries_deny_anon    ON public.webhook_deliveries;

-- Owners may read their own delivery rows (status/attempts/response for
-- debugging). The signature column is harmless to expose to the owner — it is
-- derived from their own secret — but the secret itself lives on accounts and
-- is only reachable via the SECURITY DEFINER RPC below.
CREATE POLICY webhook_deliveries_owner_select ON public.webhook_deliveries
  FOR SELECT TO authenticated
  USING (
    account_id IN (
      SELECT a.id FROM public.accounts a WHERE a.owner_user_id = auth.uid()
    )
  );

CREATE POLICY webhook_deliveries_service_all ON public.webhook_deliveries
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY webhook_deliveries_deny_anon ON public.webhook_deliveries
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. api_get_webhook_secret(p_account_id) — owner-only secret read.
--
-- Asserts ownership via api_assert_account_owner (defined in
-- 20260524000000). Returns the raw secret so the owner can verify HMAC
-- signatures of received webhooks. The secret is deliberately NOT included in
-- api_keys_public or any other broadly-granted view.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_get_webhook_secret(p_account_id uuid)
RETURNS jsonb
-- VOLATILE (not STABLE): the self-heal branch below runs an UPDATE, which
-- Postgres forbids inside a non-VOLATILE function (would raise 0A000 at runtime
-- exactly when an account has a null/empty secret).
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_secret text;
BEGIN
  PERFORM public.api_assert_account_owner(p_account_id);

  SELECT webhook_secret INTO v_secret
    FROM public.accounts
   WHERE id = p_account_id;

  IF v_secret IS NULL OR v_secret = '' THEN
    -- Self-heal: an account without a usable secret cannot verify webhooks.
    v_secret := encode(gen_random_bytes(24), 'hex');
    UPDATE public.accounts SET webhook_secret = v_secret WHERE id = p_account_id;
  END IF;

  RETURN jsonb_build_object(
    'account_id',     p_account_id,
    'webhook_secret', v_secret
  );
END;
$func$;

REVOKE ALL    ON FUNCTION public.api_get_webhook_secret(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_get_webhook_secret(uuid) TO authenticated;

COMMIT;
