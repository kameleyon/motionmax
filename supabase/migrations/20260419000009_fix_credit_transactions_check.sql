-- Fix: add signup_bonus and daily_bonus to credit_transactions.transaction_type CHECK constraint
-- The onboarding flow emits 'signup_bonus' and the daily reward job emits 'daily_bonus'.
-- Both are rejected by the current CHECK constraint, causing those INSERT calls to fail.
-- The inline constraint has no explicit name; Postgres generates credit_transactions_transaction_type_check.

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_transaction_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'purchase',
    'usage',
    'generation',
    'video_generation',
    'subscription_grant',
    'refund',
    'refund_clawback',
    'adjustment',
    'signup_bonus',
    'daily_bonus'
  ));
