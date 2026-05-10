-- B-NEW-13 (Comply L-B-02) — Per-document legal version acceptance.
--
-- Problem: profiles previously stored a SINGLE accepted_policy_version
-- column that conflated Terms of Service, Privacy Policy and the
-- Acceptable Use Policy. Material amendments to one document could not
-- be evidenced separately, and existing rows had no record of WHICH
-- version they were bound to. UCTD Directive 93/13/EEC requires us to
-- prove the specific binding version for each user at the moment of
-- acceptance, otherwise unilateral amendments are unenforceable.
--
-- Fix:
--   1) Add three (version, accepted_at) pairs — one per legal doc.
--   2) Backfill existing rows with the pre-versioning sentinel
--      '2026.02-v0' (matching the "Last updated: February 2026" copy
--      that was live before this change), and accepted_at = created_at
--      so we can prove they were bound to *some* concrete prior text.
--   3) Leave the legacy accepted_policy_version column in place — it
--      is still read by Settings.tsx for the existing privacy badge.
--      A follow-up migration can drop it once all callers migrate.
--
-- Re-acceptance flow: when profiles.tos_version_accepted differs from
-- the LEGAL_VERSIONS.tos constant in src/config/legal-versions.ts, the
-- React app fires TermsUpdateModal on next sign-in. Acceptance updates
-- all three columns to the current constants.

-- ---------------------------------------------------------------------------
-- 1. Add columns (idempotent — safe to re-run on partially migrated dbs).
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tos_version_accepted        TEXT,
  ADD COLUMN IF NOT EXISTS tos_version_accepted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS privacy_version_accepted    TEXT,
  ADD COLUMN IF NOT EXISTS privacy_version_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS aup_version_accepted        TEXT,
  ADD COLUMN IF NOT EXISTS aup_version_accepted_at     TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.tos_version_accepted IS
  'Terms of Service version (e.g. 2026.05.10-v1) the user accepted at signup '
  'or last re-acceptance. Mirrors LEGAL_VERSIONS.tos in src/config/legal-versions.ts. '
  'B-NEW-13 / Comply L-B-02.';
COMMENT ON COLUMN public.profiles.tos_version_accepted_at IS
  'Timestamp of acceptance for the version recorded in tos_version_accepted.';
COMMENT ON COLUMN public.profiles.privacy_version_accepted IS
  'Privacy Policy version accepted (mirrors LEGAL_VERSIONS.privacy). B-NEW-13.';
COMMENT ON COLUMN public.profiles.privacy_version_accepted_at IS
  'Timestamp of acceptance for the recorded privacy_version_accepted.';
COMMENT ON COLUMN public.profiles.aup_version_accepted IS
  'Acceptable Use Policy version accepted (mirrors LEGAL_VERSIONS.aup). B-NEW-13.';
COMMENT ON COLUMN public.profiles.aup_version_accepted_at IS
  'Timestamp of acceptance for the recorded aup_version_accepted.';

-- ---------------------------------------------------------------------------
-- 2. Backfill — only rows that have not already been stamped, so re-running
-- this migration after some users have re-accepted is a no-op.
-- The sentinel '2026.02-v0' deliberately doesn't match the current
-- LEGAL_VERSIONS.* constants so the app's mismatch hook prompts these users
-- to re-accept at next sign-in.
-- ---------------------------------------------------------------------------
UPDATE public.profiles
SET
  tos_version_accepted        = COALESCE(tos_version_accepted,        '2026.02-v0'),
  tos_version_accepted_at     = COALESCE(tos_version_accepted_at,     created_at),
  privacy_version_accepted    = COALESCE(privacy_version_accepted,    '2026.02-v0'),
  privacy_version_accepted_at = COALESCE(privacy_version_accepted_at, created_at),
  aup_version_accepted        = COALESCE(aup_version_accepted,        '2026.02-v0'),
  aup_version_accepted_at     = COALESCE(aup_version_accepted_at,     created_at)
WHERE
     tos_version_accepted     IS NULL
  OR privacy_version_accepted IS NULL
  OR aup_version_accepted     IS NULL;
