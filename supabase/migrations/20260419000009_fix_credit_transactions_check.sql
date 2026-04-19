-- Fix: add signup_bonus and daily_bonus to credit_transactions.transaction_type CHECK constraint
-- The inline constraint has no explicit name; Postgres generates credit_transactions_transaction_type_check

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_transaction_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'purchase',
    'usage',
    'subscription_grant',
    'refund',
    'adjustment',
    'signup_bonus',
    'daily_bonus'
  ));
