-- Add missing updated_at column to generations and wire up the update trigger.
-- Without this column there is no way to see when a generation was last mutated
-- (status changes, scene updates, completion) which breaks admin activity views.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Back-fill existing rows: prefer the most recent meaningful timestamp
-- so the column doesn't misleadingly show the migration time for old rows.
UPDATE public.generations
  SET updated_at = COALESCE(completed_at, started_at, created_at);

DROP TRIGGER IF EXISTS update_generations_updated_at ON public.generations;
CREATE TRIGGER update_generations_updated_at
  BEFORE UPDATE ON public.generations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
