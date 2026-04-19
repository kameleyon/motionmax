-- Fix PGRST203 "Could not choose the best candidate function" error.
--
-- Migration 20260419210000 added a new 5-arg variant of deduct_credits_securely
-- with an optional p_idempotency_key parameter. However, the original 4-arg
-- variant still exists in the database because the new signature did not
-- REPLACE the old one (CREATE OR REPLACE only replaces when signatures match).
--
-- Result: two overloads with identical name and identical first-4 params, and
-- the 5th param on the new one has a DEFAULT. PostgREST's RPC resolver sees
-- both candidates match a 4-arg call and refuses to pick.
--
-- Fix: drop the old 4-arg variant. The 5-arg variant with p_idempotency_key
-- defaulting to NULL is fully backward-compatible with 4-arg callers.

DROP FUNCTION IF EXISTS public.deduct_credits_securely(UUID, INT, TEXT, TEXT);

-- Reassert grants on the canonical 5-arg version so it remains callable.
GRANT EXECUTE ON FUNCTION
  public.deduct_credits_securely(UUID, INT, TEXT, TEXT, TEXT)
  TO authenticated, service_role;
