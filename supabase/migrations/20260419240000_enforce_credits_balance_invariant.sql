-- Enforce credits invariant: credits_balance must equal total_purchased - total_used.
-- A BEFORE trigger recomputes credits_balance on every INSERT/UPDATE so the column
-- is always derived from the source-of-truth columns rather than trusted blindly.

CREATE OR REPLACE FUNCTION public.enforce_credits_balance_invariant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Recompute balance from source-of-truth columns; reject negative results.
  NEW.credits_balance := NEW.total_purchased - NEW.total_used;
  IF NEW.credits_balance < 0 THEN
    RAISE EXCEPTION
      'credits invariant violation: total_used (%) exceeds total_purchased (%) for user %',
      NEW.total_used, NEW.total_purchased, NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_credits_balance_invariant ON public.user_credits;

CREATE TRIGGER trg_credits_balance_invariant
  BEFORE INSERT OR UPDATE ON public.user_credits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_credits_balance_invariant();

-- Normalize legacy rows where total_used > total_purchased (treat total_used as purchased minimum).
-- This prevents the invariant trigger from rejecting the backfill for those users.
UPDATE public.user_credits
SET total_purchased = total_used
WHERE total_used > total_purchased;

-- Back-fill any existing rows whose balance is out of sync.
UPDATE public.user_credits
SET credits_balance = total_purchased - total_used
WHERE credits_balance IS DISTINCT FROM (total_purchased - total_used);
