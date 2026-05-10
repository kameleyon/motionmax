-- supabase/seed.test.sql
-- Minimal seed data for E2E tests. Applied by the CI `e2e` job and by
-- developers running `supabase db reset` locally.
--
-- Keep this file SMALL. It runs on every test boot. Anything large or
-- realistic-data-related belongs in fixture loaders called from inside
-- specific tests via the supabase admin client.

-- ────────────────────────────────────────────────────────────────────
-- Test admin user (used by admin.spec.ts)
-- ────────────────────────────────────────────────────────────────────
-- The auth.users row is created by GoTrue on signup; we can't insert
-- directly here without conflicting with auth schemas. Tests should
-- create their own users via the admin API. This file only seeds
-- reference / config tables.

-- ────────────────────────────────────────────────────────────────────
-- Reference data: kill-switch flags default OFF for tests so happy-path
-- flows aren't blocked by an accidental ON state in the migrations.
-- ────────────────────────────────────────────────────────────────────
-- (The kill_switches table only exists once 20260218000000_kill_switches
-- has been applied. Use IF EXISTS so a partial schema doesn't error.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'kill_switches'
  ) THEN
    INSERT INTO public.kill_switches (key, enabled)
    VALUES
      ('master_kill', false),
      ('pause_payments', false),
      ('pause_signups', false),
      ('pause_generation', false)
    ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- Stripe product reference rows (if the table exists). Tests that hit
-- the create-checkout flow need at least the SKU map populated so the
-- price-validation step doesn't fail.
-- ────────────────────────────────────────────────────────────────────
-- No-op here; stripe-products are validated dynamically against a
-- Stripe TEST account, not against a DB table.

-- ────────────────────────────────────────────────────────────────────
-- Done. Add new seed rows ABOVE this line.
-- ────────────────────────────────────────────────────────────────────
SELECT 'seed.test.sql applied' AS status;
