-- ============================================================
-- Signup welcome email — idempotency flag on profiles
-- ============================================================
-- When a user signs in for the first time, the client fires
-- notify-signup-welcome (edge fn) which uses this column as an
-- atomic guard so the email goes out exactly once.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS welcome_email_sent_at timestamptz;

COMMIT;
