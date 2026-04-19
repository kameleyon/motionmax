-- ============================================================
-- 20260419000021_add_user_id_foreign_keys.sql
-- Add missing FK constraints: user_id → auth.users(id)
-- ON DELETE CASCADE to prevent orphaned rows when users
-- are deleted from auth.users.
-- Skips tables that already have the FK (profiles, projects,
-- generations, user_roles) and nullable-user_id tables
-- (system_logs) where a cascading FK is inappropriate.
-- ============================================================

-- ── Purge orphaned rows before adding FK constraints ──────
-- Rows whose user_id doesn't exist in auth.users would cause
-- the ALTER TABLE to fail.  Safe to delete: these are users
-- who were removed from auth without proper cascade cleanup.
DELETE FROM public.subscriptions       WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.user_api_keys       WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.user_credits        WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.credit_transactions WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.project_characters  WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.project_shares      WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.user_voices         WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.user_flags          WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.video_generation_jobs WHERE user_id NOT IN (SELECT id FROM auth.users);

-- ── subscriptions ─────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_user_id_fkey'
      AND conrelid = 'public.subscriptions'::regclass
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── user_api_keys ─────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_api_keys_user_id_fkey'
      AND conrelid = 'public.user_api_keys'::regclass
  ) THEN
    ALTER TABLE public.user_api_keys
      ADD CONSTRAINT user_api_keys_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── user_credits ──────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_credits_user_id_fkey'
      AND conrelid = 'public.user_credits'::regclass
  ) THEN
    ALTER TABLE public.user_credits
      ADD CONSTRAINT user_credits_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── credit_transactions ───────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_transactions_user_id_fkey'
      AND conrelid = 'public.credit_transactions'::regclass
  ) THEN
    ALTER TABLE public.credit_transactions
      ADD CONSTRAINT credit_transactions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── generation_archives ───────────────────────────────────
-- Archive rows are intentionally retained for audit/billing
-- purposes after user deletion, so we use ON DELETE SET NULL
-- rather than CASCADE.  user_id is NOT NULL in the schema,
-- so we first relax the constraint, then add the FK.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'generation_archives_user_id_fkey'
      AND conrelid = 'public.generation_archives'::regclass
  ) THEN
    -- Allow the column to become NULL so archive rows survive
    -- user deletion while still being linkable while the user
    -- exists.
    ALTER TABLE public.generation_archives
      ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE public.generation_archives
      ADD CONSTRAINT generation_archives_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── generation_costs ──────────────────────────────────────
-- Cost records are retained for financial reconciliation;
-- same SET NULL approach as generation_archives.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'generation_costs_user_id_fkey'
      AND conrelid = 'public.generation_costs'::regclass
  ) THEN
    ALTER TABLE public.generation_costs
      ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE public.generation_costs
      ADD CONSTRAINT generation_costs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── api_call_logs ─────────────────────────────────────────
-- Provider call logs are retained for billing/debugging;
-- SET NULL so records survive user deletion.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_call_logs_user_id_fkey'
      AND conrelid = 'public.api_call_logs'::regclass
  ) THEN
    ALTER TABLE public.api_call_logs
      ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE public.api_call_logs
      ADD CONSTRAINT api_call_logs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── project_characters ────────────────────────────────────
-- Characters belong to a project which already cascades from
-- auth.users via projects → project_characters.  Adding a
-- direct FK as well makes the ownership explicit.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_characters_user_id_fkey'
      AND conrelid = 'public.project_characters'::regclass
  ) THEN
    ALTER TABLE public.project_characters
      ADD CONSTRAINT project_characters_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── project_shares ────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_shares_user_id_fkey'
      AND conrelid = 'public.project_shares'::regclass
  ) THEN
    ALTER TABLE public.project_shares
      ADD CONSTRAINT project_shares_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── user_voices ───────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_voices_user_id_fkey'
      AND conrelid = 'public.user_voices'::regclass
  ) THEN
    ALTER TABLE public.user_voices
      ADD CONSTRAINT user_voices_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── user_flags ────────────────────────────────────────────
-- The flagged user (user_id) cascades on delete.
-- The admin who raised the flag (flagged_by) and the admin
-- who resolved it (resolved_by) use SET NULL so the flag
-- record is retained even if the admin account is removed.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_flags_user_id_fkey'
      AND conrelid = 'public.user_flags'::regclass
  ) THEN
    ALTER TABLE public.user_flags
      ADD CONSTRAINT user_flags_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_flags_flagged_by_fkey'
      AND conrelid = 'public.user_flags'::regclass
  ) THEN
    ALTER TABLE public.user_flags
      ALTER COLUMN flagged_by DROP NOT NULL;
    ALTER TABLE public.user_flags
      ADD CONSTRAINT user_flags_flagged_by_fkey
      FOREIGN KEY (flagged_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_flags_resolved_by_fkey'
      AND conrelid = 'public.user_flags'::regclass
  ) THEN
    -- resolved_by is already nullable in the schema
    ALTER TABLE public.user_flags
      ADD CONSTRAINT user_flags_resolved_by_fkey
      FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── video_generation_jobs ─────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_generation_jobs_user_id_fkey'
      AND conrelid = 'public.video_generation_jobs'::regclass
  ) THEN
    ALTER TABLE public.video_generation_jobs
      ADD CONSTRAINT video_generation_jobs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── admin_logs ────────────────────────────────────────────
-- admin_id is the actor performing the action; use SET NULL
-- so audit logs are retained when an admin account is removed.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_logs_admin_id_fkey'
      AND conrelid = 'public.admin_logs'::regclass
  ) THEN
    ALTER TABLE public.admin_logs
      ALTER COLUMN admin_id DROP NOT NULL;
    ALTER TABLE public.admin_logs
      ADD CONSTRAINT admin_logs_admin_id_fkey
      FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── NOTE: tables intentionally skipped ────────────────────
-- • profiles          — FK already present (001_full_schema.sql)
-- • projects          — FK already present (001_full_schema.sql)
-- • generations       — FK already present (001_full_schema.sql)
-- • user_roles        — FK already present (001_full_schema.sql)
-- • system_logs       — user_id is nullable (system events have
--                       no user); adding FK with SET NULL would
--                       be a no-op; CASCADE would be dangerous
--                       for system-level audit entries.
-- • webhook_events    — no user_id column
