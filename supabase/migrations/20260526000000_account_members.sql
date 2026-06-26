-- ─────────────────────────────────────────────────────────────────────────────
-- MotionMax Public API — Phase 4 (Post-GA): account_members (teams/orgs).
--
-- Until now `public.accounts` was strictly one-per-user (UNIQUE owner_user_id);
-- the owner WAS the account. This migration introduces a membership table so an
-- account can have multiple users with roles, while keeping the legacy owner
-- path byte-for-byte compatible:
--
--   public.account_members(account_id, user_id, role)  — many users per account.
--
-- The single owner-resolution path (accounts.owner_user_id = auth.uid()) still
-- works unchanged. Membership is ADDITIVE: every existing account is backfilled
-- with exactly one 'owner' member (its current owner_user_id), and the
-- ownership-assertion helper is widened so account admins (not only the literal
-- owner) may manage API keys. Owner-EXCLUSIVE operations are intentionally NOT
-- routed through this helper, so they keep their owner-only semantics.
--
-- Idempotent: safe to re-run. RLS: a member SELECTs rows of accounts they belong
-- to; service_role full; anon denied.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. account_members
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.account_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id)      ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member'
               CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS account_members_user_id_idx
  ON public.account_members (user_id);

CREATE INDEX IF NOT EXISTS account_members_account_id_idx
  ON public.account_members (account_id);

ALTER TABLE public.account_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_members FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_members_self_select ON public.account_members;
DROP POLICY IF EXISTS account_members_service_all ON public.account_members;
DROP POLICY IF EXISTS account_members_deny_anon   ON public.account_members;

-- A user may SELECT their OWN membership row, and an account owner may SELECT
-- every row of accounts they own. The policy MUST NOT subquery account_members
-- itself — Postgres re-applies the policy to that self-reference and raises
-- "infinite recursion detected in policy for relation account_members" on any
-- RLS-scoped (JWT-direct) SELECT. The full team roster for owners/admins is
-- served by the SECURITY DEFINER api_list_members() RPC, which is the intended
-- read surface and is already owner/admin-gated.
CREATE POLICY account_members_self_select ON public.account_members
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR account_id IN (
      SELECT a.id FROM public.accounts a WHERE a.owner_user_id = auth.uid()
    )
  );

CREATE POLICY account_members_service_all ON public.account_members
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY account_members_deny_anon ON public.account_members
  AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Backfill: one 'owner' membership per existing account.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.account_members (account_id, user_id, role)
SELECT a.id, a.owner_user_id, 'owner'
  FROM public.accounts a
ON CONFLICT (account_id, user_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Widen api_assert_account_owner: pass for the literal owner OR an
-- account_members row with role IN ('owner','admin'). Signature, SECURITY
-- DEFINER, search_path, and the 42501 failure mode are PRESERVED so every
-- existing caller (api_create_key / api_rotate_key / api_revoke_key, and the
-- new membership RPCs) keeps working. This widens KEY-MANAGEMENT to admins;
-- owner-EXCLUSIVE operations must NOT call this helper.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_assert_account_owner(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_uid   uuid := auth.uid();
  v_owner uuid;
  v_role  text;
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

  -- Fast path: literal account owner.
  IF v_owner = v_uid THEN
    RETURN;
  END IF;

  -- Widened path: an owner/admin membership grants management rights.
  SELECT role INTO v_role
    FROM public.account_members
   WHERE account_id = p_account_id
     AND user_id    = v_uid
   LIMIT 1;

  IF v_role IN ('owner', 'admin') THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'api_assert_account_owner: forbidden' USING ERRCODE = '42501';
END;
$func$;

REVOKE ALL ON FUNCTION public.api_assert_account_owner(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_assert_account_owner(uuid) TO authenticated;

-- STRICT variant: passes ONLY for a literal account owner or an account_members
-- row with role='owner' — admins do NOT pass. Used to gate owner-role mutations
-- (granting 'owner', or demoting an existing owner) so an admin can neither
-- self-promote to owner nor strip/orphan the owner.
CREATE OR REPLACE FUNCTION public.api_assert_account_owner_strict(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_uid   uuid := auth.uid();
  v_owner uuid;
  v_role  text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'api_assert_account_owner_strict: not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT owner_user_id INTO v_owner
    FROM public.accounts
   WHERE id = p_account_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'api_assert_account_owner_strict: account not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_owner = v_uid THEN
    RETURN;
  END IF;

  SELECT role INTO v_role
    FROM public.account_members
   WHERE account_id = p_account_id
     AND user_id    = v_uid
   LIMIT 1;

  IF v_role = 'owner' THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'api_assert_account_owner_strict: owner role required' USING ERRCODE = '42501';
END;
$func$;

REVOKE ALL ON FUNCTION public.api_assert_account_owner_strict(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_assert_account_owner_strict(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. api_add_member(p_account_id, p_user_email, p_role) — owner/admin-gated.
-- Resolves an auth.users row by email and inserts (or no-ops on conflict) a
-- membership. Returns the membership row as jsonb.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_add_member(
  p_account_id  uuid,
  p_user_email  text,
  p_role        text DEFAULT 'member'
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_uid           uuid;
  v_id            uuid;
  v_role          text;
  v_created       timestamptz;
  v_existing_role text;
  v_owner_count   integer;
BEGIN
  PERFORM public.api_assert_account_owner(p_account_id);

  IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'api_add_member: role must be owner, admin, or member'
      USING ERRCODE = '22023';
  END IF;

  IF p_user_email IS NULL OR length(trim(p_user_email)) = 0 THEN
    RAISE EXCEPTION 'api_add_member: email is required' USING ERRCODE = '22023';
  END IF;

  SELECT u.id INTO v_uid
    FROM auth.users u
   WHERE lower(u.email) = lower(trim(p_user_email))
   LIMIT 1;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'api_add_member: no user with that email' USING ERRCODE = 'P0002';
  END IF;

  -- Owner-role mutations are OWNER-ONLY. Granting 'owner' (P4-1: stops an admin
  -- self-promoting and taking over) OR changing an existing owner's role
  -- (P4-2: stops an admin demoting/orphaning the owner) requires the STRICT
  -- owner gate; a plain admin cannot do either.
  SELECT role INTO v_existing_role
    FROM public.account_members
   WHERE account_id = p_account_id
     AND user_id    = v_uid
   LIMIT 1;

  IF p_role = 'owner' OR v_existing_role = 'owner' THEN
    PERFORM public.api_assert_account_owner_strict(p_account_id);
  END IF;

  -- Never demote the last owner to a non-owner role.
  IF v_existing_role = 'owner' AND p_role <> 'owner' THEN
    SELECT count(*) INTO v_owner_count
      FROM public.account_members
     WHERE account_id = p_account_id
       AND role       = 'owner';
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'api_add_member: cannot demote the last owner'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.account_members (account_id, user_id, role)
  VALUES (p_account_id, v_uid, p_role)
  ON CONFLICT (account_id, user_id)
  DO UPDATE SET role = EXCLUDED.role
  RETURNING id, role, created_at INTO v_id, v_role, v_created;

  RETURN jsonb_build_object(
    'id',         v_id,
    'account_id', p_account_id,
    'user_id',    v_uid,
    'role',       v_role,
    'created_at', v_created
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.api_add_member(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_add_member(uuid, text, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. api_remove_member(p_account_id, p_user_id) — owner/admin-gated.
-- Rejects removing the LAST owner so an account can never be orphaned.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_remove_member(
  p_account_id uuid,
  p_user_id    uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
DECLARE
  v_role        text;
  v_owner_count integer;
BEGIN
  PERFORM public.api_assert_account_owner(p_account_id);

  SELECT role INTO v_role
    FROM public.account_members
   WHERE account_id = p_account_id
     AND user_id    = p_user_id
   LIMIT 1;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'api_remove_member: membership not found' USING ERRCODE = 'P0002';
  END IF;

  -- Never strand an account without an owner.
  IF v_role = 'owner' THEN
    SELECT count(*) INTO v_owner_count
      FROM public.account_members
     WHERE account_id = p_account_id
       AND role       = 'owner';

    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'api_remove_member: cannot remove the last owner'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  DELETE FROM public.account_members
   WHERE account_id = p_account_id
     AND user_id    = p_user_id;

  RETURN jsonb_build_object(
    'account_id', p_account_id,
    'user_id',    p_user_id,
    'removed',    true
  );
END;
$func$;

REVOKE ALL ON FUNCTION public.api_remove_member(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_remove_member(uuid, uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. api_list_members(p_account_id) — owner/admin-gated roster.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_list_members(p_account_id uuid)
RETURNS TABLE (
  user_id    uuid,
  role       text,
  created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $func$
BEGIN
  PERFORM public.api_assert_account_owner(p_account_id);

  RETURN QUERY
    SELECT am.user_id, am.role, am.created_at
      FROM public.account_members am
     WHERE am.account_id = p_account_id
     ORDER BY am.created_at ASC;
END;
$func$;

REVOKE ALL ON FUNCTION public.api_list_members(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.api_list_members(uuid) TO authenticated;

COMMIT;
