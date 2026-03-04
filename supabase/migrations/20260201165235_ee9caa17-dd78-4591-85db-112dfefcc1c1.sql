-- Create table to track API costs per generation
CREATE TABLE public.generation_costs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  generation_id UUID NOT NULL,
  user_id UUID NOT NULL,
  openrouter_cost DECIMAL(10, 6) DEFAULT 0,
  replicate_cost DECIMAL(10, 6) DEFAULT 0,
  hypereal_cost DECIMAL(10, 6) DEFAULT 0,
  google_tts_cost DECIMAL(10, 6) DEFAULT 0,
  total_cost DECIMAL(10, 6) GENERATED ALWAYS AS (openrouter_cost + replicate_cost + hypereal_cost + google_tts_cost) STORED,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.generation_costs ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Admins can view all costs"
ON public.generation_costs
FOR SELECT
USING (public.is_admin(auth.uid()));

CREATE POLICY "Deny anonymous access to generation_costs"
ON public.generation_costs
FOR ALL
USING (false)
WITH CHECK (false);

-- Service role can insert costs (from edge functions)
CREATE POLICY "Service role can insert costs"
ON public.generation_costs
FOR INSERT
WITH CHECK (true);

-- Create index for efficient queries
CREATE INDEX idx_generation_costs_user_id ON public.generation_costs(user_id);
CREATE INDEX idx_generation_costs_generation_id ON public.generation_costs(generation_id);