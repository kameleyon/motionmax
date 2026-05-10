-- B-NEW-14 (Comply L-B-03) — AI training opt-in flag.
--
-- Problem: src/pages/Privacy.tsx and marketing/src/pages/privacy.astro
-- both promise the user "AI training opt-in (if you explicitly enable
-- it)" — but no toggle, no column and no enforcement code existed.
-- Promising functionality that does not exist is a strict-liability
-- FTC §5 risk (deceptive practice), and the same wording read against
-- GDPR Art. 6(1)(a) creates an enforceability problem in the EEA.
--
-- Fix:
--   1) Add profiles.ai_training_opt_in BOOLEAN NOT NULL DEFAULT FALSE.
--      Default is OPT-OUT — motionmax does NOT train on user data
--      unless the user explicitly toggles this on in Settings. Existing
--      rows are backfilled to FALSE (matches the default), preserving
--      the conservative posture for every legacy account.
--   2) Add profiles.ai_training_opt_in_changed_at TIMESTAMPTZ NULL —
--      timestamps the most recent toggle so users can verify the
--      effective date in their export-my-data archive (Art. 20) and
--      so support can prove consent state at any historical moment.
--
-- Privacy Policy reference: §3 ("We do not use your generated content
-- to train AI models without explicit opt-in consent") and §4
-- ("Consent (Art. 6(1)(a)): […] AI training opt-in (if you explicitly
-- enable it)"). The Settings UI lives at src/components/settings/
-- AITrainingOptInSection.tsx and writes through the user's own JWT,
-- so the existing profiles-self-update RLS policy gates the write.
--
-- Future harvesting code MUST gate on this column (see
-- docs/ai-training-policy.md). At the time of this migration NO
-- harvesting code exists in the repo — verified by grepping
-- "training", "harvest", "fine-tune", "telemetry" across src/,
-- supabase/functions/ and worker/.

-- ---------------------------------------------------------------------------
-- 1. Add columns (idempotent — safe to re-run on partially migrated dbs).
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ai_training_opt_in            BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_training_opt_in_changed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.profiles.ai_training_opt_in IS
  'OPT-OUT-by-default flag: when TRUE the user has explicitly consented to '
  'their projects, scripts, voice samples and generated content being used '
  'to train AI models. Default FALSE (motionmax does NOT train on user '
  'data unless this is TRUE). Implements the promise made in Privacy '
  'Policy §3 and the Art. 6(1)(a) consent basis in §4. Any future '
  'harvesting code path MUST check this column. B-NEW-14 / Comply L-B-03 '
  '(FTC §5 strict-liability + GDPR Art. 6).';

COMMENT ON COLUMN public.profiles.ai_training_opt_in_changed_at IS
  'Timestamp of the most recent toggle of ai_training_opt_in (NULL if the '
  'user has never changed the default). Surfaced in the Settings UI as '
  '"Last changed: <date>" and in export-my-data so users can verify the '
  'effective date of their consent state. B-NEW-14.';

-- ---------------------------------------------------------------------------
-- 2. Backfill — explicit, even though the column default already wrote
-- FALSE to every existing row. This belt-and-braces UPDATE makes the
-- conservative default obvious to anyone auditing the migration history,
-- and is a no-op if rerun.
-- ---------------------------------------------------------------------------
UPDATE public.profiles
SET ai_training_opt_in = FALSE
WHERE ai_training_opt_in IS DISTINCT FROM FALSE;
