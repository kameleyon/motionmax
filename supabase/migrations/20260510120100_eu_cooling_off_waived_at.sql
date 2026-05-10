-- B-V1-5 (Comply L-B-05) — EU/EEA/UK 14-day right of withdrawal waiver.
--
-- Directive 2011/83/EU Art. 16(m): for digital services (e.g. AI generation),
-- the consumer keeps a 14-day right of withdrawal UNLESS they have given
-- EXPRESS prior consent to immediate performance AND ACKNOWLEDGED that they
-- will lose that right once the service has been performed. The same duty
-- exists in the UK Consumer Rights Act 2015 + CCRs 2013 reg. 37.
--
-- The consent must be evidenced — a generic ToS click-through is NOT enough.
-- We therefore record a per-user, per-event timestamp on the FIRST occasion
-- the user ticks the binding checkbox on /pricing (or the billing tabs) and
-- proceeds to checkout. The frontend captures the consent and passes
-- `eu_cooling_off_waived: true` in the create-checkout edge function body;
-- that function stamps this column before opening the Stripe Checkout
-- Session. The Stripe customer record carries the same evidence as a
-- belt-and-suspenders backup (and to allow reconciliation if this DB
-- write ever fails).
--
-- A NULL value here means "no waiver on record" — which is the legally
-- correct default. We deliberately do NOT backfill: pre-existing users who
-- have not been re-prompted have not given express consent, so claiming
-- otherwise would itself be a Directive 2011/83/EU violation.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS eu_cooling_off_waived_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.profiles.eu_cooling_off_waived_at IS
  'Timestamp at which the user gave express consent to immediate performance '
  'of the digital service AND acknowledged loss of the 14-day right of '
  'withdrawal. NULL = no waiver on record (legally the safe default — the '
  'consumer retains full statutory withdrawal rights). Stamped by the '
  'create-checkout edge function. B-V1-5 / Directive 2011/83/EU Art. 16(m) '
  '/ UK CCRs 2013 reg. 37.';
