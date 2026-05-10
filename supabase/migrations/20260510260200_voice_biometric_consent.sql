-- Wave 4 / C-13-3 (Comply L-C-03) — voice biometric consent timestamp.
--
-- Problem: voice-clone audio is a biometric identifier under the
-- Illinois Biometric Information Privacy Act (BIPA), Texas Capture or
-- Use of Biometric Identifier Act (CUBI), and California CPRA. BIPA
-- enforcement is $1,000 per negligent violation and up to $5,000 per
-- intentional / reckless violation, assessed per-violation (Cothron v.
-- White Castle, IL Supreme Court 2023, made it per-scan). Prior to this
-- migration motionmax stored voice recordings without recording the
-- explicit moment of biometric-data consent — making it functionally
-- impossible to defend against a "we never consented" claim.
--
-- Fix:
--   1) Add user_voices.voice_biometric_consent_at TIMESTAMPTZ NULL.
--      Stamped at upload time by the clone-voice-fish edge function
--      when the user checks the biometric-consent checkbox in
--      src/pages/VoiceLab.tsx (the second of two consent checkboxes
--      added in this wave). NULL on legacy rows — see backfill note
--      below for how those are treated.
--   2) NULL is intentionally the legacy sentinel: rows whose consent
--      timestamp is NULL were created BEFORE the explicit BIPA capture
--      shipped. Those users still accepted the prior consent checkbox
--      (which covered ownership-or-permission), so the recordings are
--      not unlawfully held — but they were not asked the BIPA-specific
--      question. The product surface treats NULL as "consent not on
--      file" and prompts the user to re-affirm via a one-click modal
--      the next time they open Voice Lab (handled in app code, not
--      this migration).
--
-- Privacy Policy reference:
--   src/pages/Privacy.tsx §7.1 (Voice Biometric Data) and the matching
--   astro page marketing/src/pages/privacy.astro §7.1 now explicitly
--   classify voice recordings as biometric identifiers and reference
--   this column by name as the consent-of-record.
--
-- AUP reference:
--   src/pages/AcceptableUse.tsx §2.1 (Voice Cloning Consent) and the
--   astro mirror — written-consent requirement for voice cloning.
--
-- See also: migration 20260510150000_ai_training_opt_in.sql for the
-- same belt-and-braces pattern (opt-out default, timestamp column,
-- explicit backfill).

-- ---------------------------------------------------------------------------
-- 1. Add column (idempotent — safe to re-run).
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_voices
  ADD COLUMN IF NOT EXISTS voice_biometric_consent_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.user_voices.voice_biometric_consent_at IS
  'Timestamp at which the user explicitly consented to collection, storage '
  'and processing of this voice recording as biometric data under BIPA / '
  'CUBI / CPRA. Stamped by the clone-voice-fish edge function when the '
  'biometric-consent checkbox is checked in Voice Lab. NULL on rows created '
  'before C-13-3 shipped — those users will be re-prompted in-app. Required '
  'for proof of consent in any BIPA / CUBI / CPRA enforcement action. '
  'Wave 4 / Comply L-C-03.';

-- ---------------------------------------------------------------------------
-- 2. Backfill is intentionally a NO-OP. Legacy rows MUST stay NULL so the
-- app layer can detect them and prompt for explicit biometric consent on
-- next interaction. Pre-stamping legacy rows with now() or created_at
-- would manufacture evidence we don't actually have.
-- ---------------------------------------------------------------------------
-- (no UPDATE statement on purpose — see comment above)

-- ---------------------------------------------------------------------------
-- 3. Optional reporting index — small partial index for the cron job that
-- will sweep voices without consent on file and surface them to support
-- and to the BIPA re-prompt modal. Partial on the NULL filter so the
-- index stays tiny in steady state.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS user_voices_pending_biometric_consent_idx
  ON public.user_voices (user_id, created_at)
  WHERE voice_biometric_consent_at IS NULL;
