-- §11 Lens C4 — server-side GA4 client_id capture.
--
-- The Stripe webhook fires a server-side GA4 `purchase` event via the
-- Measurement Protocol. Until now it passed `userId` (the Supabase
-- UUID) as the GA4 `client_id`. That doesn't match the anonymous GA
-- client_id GA4 minted on the original ad-click pageview, so GA4
-- couldn't stitch the conversion to the session that drove it — every
-- purchase showed as "(direct) / (none)" with no UTMs, and ROAS for
-- paid acquisition was effectively unknowable.
--
-- The fix is to persist the GA4 `_ga` cookie value at signup (the
-- client_id GA4 minted on the user's first pageview), then read it
-- back when the webhook fires Measurement Protocol so GA4 can join
-- the conversion to the original session.
--
-- We could shove it inside the existing profiles.acquisition JSONB
-- (Wave 5 added that column) but a top-level column has two wins:
--
--   • Indexable. The webhook does `SELECT ga_client_id FROM profiles
--     WHERE user_id = $1`. JSONB ->> lookups work too but the planner
--     can't use the JSON values in a btree without a functional index.
--   • One backfill path. If we ever migrate to a dedicated analytics
--     warehouse, copying a single column is simpler than json_extract.
--
-- The column is NULL on every existing row (no backfill possible —
-- the cookie value isn't recoverable). Future signups populate it via
-- the React app reading `document.cookie` for `_ga`.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ga_client_id TEXT NULL;

COMMENT ON COLUMN public.profiles.ga_client_id IS
  '§11 Lens C4 — GA4 anonymous client_id (the `_ga` cookie value '
  'minted on the user''s first pageview). Used by the Stripe webhook''s '
  'Measurement Protocol fire so server-side purchases stitch to the '
  'original ad-click session. NULL means we did not capture it at '
  'signup (cookies disabled, GA hadn''t loaded yet, or the user signed '
  'up before this column existed). Falls back to user_id in that case.';
