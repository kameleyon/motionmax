-- Add credits_deducted column to generations table
-- This tracks how many credits were deducted for this generation
-- so we can refund them if the generation fails

ALTER TABLE public.generations
ADD COLUMN IF NOT EXISTS credits_deducted INTEGER DEFAULT 0;

COMMENT ON COLUMN public.generations.credits_deducted IS 'Number of credits deducted for this generation (used for refunds on failure)';
