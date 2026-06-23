-- ─────────────────────────────────────────────────────────────────────────────
-- MotionMax Public API — accounts + customer-scoped api_keys (Phase 0/1).
--
-- These are the CUSTOMER-FACING tenancy tables for the public /api/v1 gateway.
-- They are DISTINCT from public.internal_api_keys (admin-scoped, created in
-- 20260505220000). Hashing scheme is reused: token = 'mm_'||env||'_'||base64url
-- of 24 random bytes, prefix = first 12 chars, token_hash = sha256 hex.
--
--   public.accounts   — one tenant; owns credits (via owner_user_id) + keys.
--   public.api_keys   — bearer credentials issued to an account.
--
-- Idempotent: safe to re-run. RLS: account owner SELECTs own rows (never the
-- token_hash); service_role full; anon denied.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- pgcrypto provides gen_random_bytes() + digest(); enabled in earlier migrations
-- but guarded here so this file is self-contained.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. accounts
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tier          text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'creator', 'studio')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One single-member account per user for the initial rollout. A partial unique
-- index keeps the backfill idempotent and prevents accidental duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_owner_user_id_key
  ON public.accounts (owner_user_id);

CREATE INDEX IF NOT EXISTS accounts_status_idx
  ON public.accounts (status);

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounts_owner_select  ON public.accounts;
DROP POLICY IF EXISTS accounts_service_all   ON public.accounts;
DROP POLICY IF EXISTS accounts_deny_anon     ON public.accounts;

CREATE POLICY accounts_owner_select ON public.accounts
  FOR SELECT TO authenticated
  USING (owner_user_id = auth.uid());

CREATE POLICY accounts_service_all ON public.accounts
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY accounts_deny_anon ON public.accounts
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. api_keys (customer-scoped bearer credentials)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  env          text NOT NULL CHECK (env IN ('live', 'test')),
  prefix       text NOT NULL,
  last4        text NOT NULL,
  token_hash   text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{}'::text[],
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked')),
  last_used_at timestamptz,
  calls_count  bigint NOT NULL DEFAULT 0,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_token_hash_key
  ON public.api_keys (token_hash);

CREATE INDEX IF NOT EXISTS api_keys_account_id_idx
  ON public.api_keys (account_id);

CREATE INDEX IF NOT EXISTS api_keys_status_idx
  ON public.api_keys (status);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_keys_owner_select ON public.api_keys;
DROP POLICY IF EXISTS api_keys_service_all  ON public.api_keys;
DROP POLICY IF EXISTS api_keys_deny_anon    ON public.api_keys;

-- Owners may read metadata of their own keys. They MUST NOT see token_hash;
-- a column-restricted view is exposed below and clients should select from it.
-- The RLS policy here still bounds the rows to the owner's account.
CREATE POLICY api_keys_owner_select ON public.api_keys
  FOR SELECT TO authenticated
  USING (
    account_id IN (
      SELECT a.id FROM public.accounts a WHERE a.owner_user_id = auth.uid()
    )
  );

CREATE POLICY api_keys_service_all ON public.api_keys
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY api_keys_deny_anon ON public.api_keys
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- Column-safe view for owners: everything EXCEPT token_hash. Runs with the
-- invoker's privileges so RLS on api_keys still applies.
CREATE OR REPLACE VIEW public.api_keys_public
WITH (security_invoker = true) AS
  SELECT
    id, account_id, env, prefix, last4, scopes, status,
    last_used_at, calls_count, expires_at, created_at
  FROM public.api_keys;

REVOKE ALL ON public.api_keys_public FROM anon;
GRANT SELECT ON public.api_keys_public TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Backfill: one single-member account per existing auth user.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.accounts (owner_user_id)
SELECT u.id
  FROM auth.users u
 WHERE NOT EXISTS (
   SELECT 1 FROM public.accounts a WHERE a.owner_user_id = u.id
 )
ON CONFLICT (owner_user_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. updated_at trigger for accounts.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_accounts_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $func$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_accounts_touch_updated_at ON public.accounts;
CREATE TRIGGER trg_accounts_touch_updated_at
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.api_accounts_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Internal helper: resolve the caller's account, asserting ownership.
-- Used by the management RPCs to keep the ownership check in one place.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_assert_account_owner(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_uid   uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'api_assert_account_owner: not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT owner_user_id INTO v_owner
    FROM public.accounts
   WHERE id = p_account_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'api_assert_account_owner: account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_owner <> v_uid THEN
    RAISE EXCEPTION 'api_assert_account_owner: forbidden' USING ERRCODE = '42501';
  END IF;
END;
$func$;

REVOKE ALL ON FUNCTION public.api_assert_account_owner(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_assert_account_owner(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. api_create_key(p_account_id, p_env, p_scopes)
-- Generates a token, returns the plaintext ONCE; stores only the sha256 hash.
-- Token: mm_<env>_<32 base64-url chars>.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_create_key(
  p_account_id uuid,
  p_env        text DEFAULT 'live',
  p_scopes     text[] DEFAULT '{}'::text[]
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_token  text;
  v_hash   text;
  v_prefix text;
  v_last4  text;
  v_id     uuid;
BEGIN
  PERFORM public.api_assert_account_owner(p_account_id);

  IF p_env IS NULL OR p_env NOT IN ('live', 'test') THEN
    RAISE EXCEPTION 'api_create_key: env must be live or test' USING ERRCODE = '22023';
  END IF;

  -- Token: mm_<env>_<base64url(24 bytes)>. base64url-ify the raw base64.
  v_token  := 'mm_' || p_env || '_' || encode(gen_random_bytes(24), 'base64');
  v_token  := replace(replace(replace(v_token, '/', '_'), '+', '-'), '=', '');
  v_prefix := substring(v_token from 1 for 12);
  v_last4  := right(v_token, 4);
  v_hash   := encode(digest(v_token, 'sha256'), 'hex');

  INSERT INTO public.api_keys (account_id, env, prefix, last4, token_hash, scopes)
  VALUES (p_account_id, p_env, v_prefix, v_last4, v_hash, COALESCE(p_scopes, '{}'::text[]))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id',     v_id,
    'token',  v_token,
    'prefix', v_prefix,
    'last4',  v_last4,
    'env',    p_env
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.api_create_key(uuid, text, text[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_create_key(uuid, text, text[]) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. api_rotate_key(p_id) — marks the old key 'rotated', issues a new active
-- key on the same account with the same env + scopes. Returns the new token once.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_rotate_key(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_old RECORD;
  v_new jsonb;
BEGIN
  SELECT id, account_id, env, scopes, status
    INTO v_old
    FROM public.api_keys
   WHERE id = p_id
   FOR UPDATE;

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'api_rotate_key: key not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.api_assert_account_owner(v_old.account_id);

  IF v_old.status = 'revoked' THEN
    RAISE EXCEPTION 'api_rotate_key: key is revoked' USING ERRCODE = '22023';
  END IF;

  UPDATE public.api_keys
     SET status = 'rotated'
   WHERE id = p_id;

  v_new := public.api_create_key(v_old.account_id, v_old.env, v_old.scopes);

  RETURN jsonb_build_object(
    'rotated_id', p_id,
    'id',         v_new->>'id',
    'token',      v_new->>'token',
    'prefix',     v_new->>'prefix',
    'last4',      v_new->>'last4',
    'env',        v_new->>'env'
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.api_rotate_key(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_rotate_key(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. api_revoke_key(p_id) — permanently disables a key.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_revoke_key(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_old RECORD;
BEGIN
  SELECT id, account_id, status
    INTO v_old
    FROM public.api_keys
   WHERE id = p_id
   FOR UPDATE;

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'api_revoke_key: key not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.api_assert_account_owner(v_old.account_id);

  UPDATE public.api_keys
     SET status = 'revoked'
   WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'status', 'revoked');
END;
$func$;

REVOKE ALL ON FUNCTION public.api_revoke_key(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_revoke_key(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. api_key_touch(p_id) — best-effort usage bump called by the gateway on
-- every authenticated request. Service-role only (the public auth path runs
-- under service_role); never granted to authenticated/anon.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_key_touch(p_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
BEGIN
  UPDATE public.api_keys
     SET last_used_at = now(),
         calls_count  = calls_count + 1
   WHERE id = p_id;
END;
$func$;

REVOKE ALL ON FUNCTION public.api_key_touch(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.api_key_touch(uuid) FROM authenticated;

COMMIT;
