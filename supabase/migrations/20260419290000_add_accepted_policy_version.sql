-- Track which privacy-policy version each user accepted at sign-up.
-- NULL means the user pre-dates this column (legacy accounts).
-- Re-acceptance prompts are triggered by comparing this value against
-- the CURRENT_POLICY_VERSION constant defined in src/lib/policyVersion.ts.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS accepted_policy_version TEXT,
  ADD COLUMN IF NOT EXISTS accepted_policy_at       TIMESTAMPTZ;
