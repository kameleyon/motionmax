-- Create public shares table for view-only project sharing
CREATE TABLE public.project_shares (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  share_token text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone DEFAULT NULL,
  view_count integer NOT NULL DEFAULT 0
);

-- Create index on share_token for fast lookups
CREATE INDEX idx_project_shares_token ON public.project_shares(share_token);

-- Enable RLS
ALTER TABLE public.project_shares ENABLE ROW LEVEL SECURITY;

-- Users can manage their own shares
CREATE POLICY "Users can create their own shares" 
ON public.project_shares 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own shares" 
ON public.project_shares 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own shares" 
ON public.project_shares 
FOR DELETE 
USING (auth.uid() = user_id);

-- Public can view share data by token (for the public view page)
CREATE POLICY "Anyone can view by share token" 
ON public.project_shares 
FOR SELECT 
USING (true);

-- Allow incrementing view count (public access)
CREATE POLICY "Anyone can update view count" 
ON public.project_shares 
FOR UPDATE 
USING (true)
WITH CHECK (true);