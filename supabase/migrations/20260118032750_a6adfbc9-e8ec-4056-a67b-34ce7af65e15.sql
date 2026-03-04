-- Add project_type column to distinguish between Doc2Video and Storytelling
ALTER TABLE public.projects 
ADD COLUMN project_type TEXT NOT NULL DEFAULT 'doc2video';

-- Add storytelling-specific columns
ALTER TABLE public.projects 
ADD COLUMN inspiration_style TEXT NULL;

ALTER TABLE public.projects 
ADD COLUMN story_tone TEXT NULL;

ALTER TABLE public.projects 
ADD COLUMN story_genre TEXT NULL;

ALTER TABLE public.projects 
ADD COLUMN voice_inclination TEXT NULL;

-- Add index for filtering by project type
CREATE INDEX idx_projects_user_type ON public.projects(user_id, project_type);

-- Create source_uploads storage bucket for future audio uploads
INSERT INTO storage.buckets (id, name, public)
VALUES ('source_uploads', 'source_uploads', true)
ON CONFLICT (id) DO NOTHING;

-- RLS policies for source_uploads bucket
CREATE POLICY "Users can upload their own source files"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'source_uploads' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can view their own source files"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'source_uploads' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can delete their own source files"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'source_uploads' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);