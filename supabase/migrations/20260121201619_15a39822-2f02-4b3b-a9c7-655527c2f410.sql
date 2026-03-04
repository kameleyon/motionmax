-- credit_transactions: Block all client-side inserts (service role bypasses RLS)
CREATE POLICY "Only service role can insert credit transactions"
ON public.credit_transactions
FOR INSERT
WITH CHECK (false);

-- This policy ensures:
-- 1. Authenticated users CANNOT insert credit transactions from the client
-- 2. Service role (used by edge functions like stripe-webhook) can still insert because it bypasses RLS
-- 3. Credit transactions can only be created through legitimate payment processing