-- B-NEW-7 (Lens B) — acquisition / first-touch attribution column.
--
-- Problem: a paid-search visitor lands on motionmax.io with
--   ?utm_source=google&utm_campaign=launch
-- and signs up at app.motionmax.io. The signup row contained NO record
-- of the campaign, so we could never tie a CAC measurement back to the
-- ad spend that drove it. The marketing UTMs were captured client-side
-- (sessionStorage in useAnalytics.ts) but never written server-side,
-- so they died on first refresh.
--
-- Fix: add a single JSONB column `profiles.acquisition` that stores the
-- full UTM blob written once at signup by useAuth's onAuthStateChange
-- handler. We chose a single JSONB blob rather than seven flat columns
-- (utm_source, utm_medium, utm_campaign, utm_term, utm_content, gclid,
-- fbclid + captured_at + landing_url) for three reasons:
--
--   1. Forward-compat. Adding "li_fat_id" or "msclkid" later is a
--      no-migration change — just a new key in the blob.
--   2. Sparse storage. Most signups have 1-2 UTM keys set, not all
--      seven. JSONB is more compact than seven nullable columns when
--      the typical row is mostly NULL.
--   3. Queryability is preserved. Postgres JSONB supports
--      `acquisition->>'utm_source'` indexing if we want a per-source
--      conversion-rate query later — same expressiveness as columns.
--
-- No backfill: existing users have no UTM data we can recover. The
-- column stays NULL for them; future signups populate it. Analytics
-- queries that GROUP BY utm_source must coalesce to '(direct)' or
-- '(legacy)' for NULL rows, the standard convention.
--
-- Idempotency: write only happens when acquisition IS NULL (see the
-- `.is("acquisition", null)` filter in useAuth.ts). A second signup
-- attempt or a re-trigger of SIGNED_IN cannot overwrite an existing
-- attribution.

-- ---------------------------------------------------------------------------
-- 1. Add column (idempotent — safe to re-run on partially migrated dbs).
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS acquisition JSONB NULL;

COMMENT ON COLUMN public.profiles.acquisition IS
  'First-touch attribution blob, written once at signup from the '
  '.motionmax.io-scoped motionmax_utm cookie. Shape: { utm_source, '
  'utm_medium, utm_campaign, utm_term, utm_content, gclid, fbclid, '
  'captured_at, landing_url } — any field may be null. NULL on the row '
  'means the user was either organic / direct, signed up before this '
  'column existed (no backfill), or signed up with cookies disabled. '
  'Query examples: acquisition->>''utm_source'' for per-channel CAC; '
  'acquisition->>''gclid'' IS NOT NULL for paid-search attribution. '
  'B-NEW-7 (Lens B).';
