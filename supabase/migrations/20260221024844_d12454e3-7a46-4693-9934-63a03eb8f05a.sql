
-- Add thumbnail_url column to projects table
ALTER TABLE projects ADD COLUMN thumbnail_url TEXT;

-- Create public bucket for permanent project thumbnails
INSERT INTO storage.buckets (id, name, public) VALUES ('project-thumbnails', 'project-thumbnails', true);

-- Allow anyone to view project thumbnails (public bucket)
CREATE POLICY "Public read access for project thumbnails"
ON storage.objects FOR SELECT
USING (bucket_id = 'project-thumbnails');

-- Allow service role to upload thumbnails (edge functions use service role)
CREATE POLICY "Service role can upload project thumbnails"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'project-thumbnails');

-- Allow service role to delete old thumbnails
CREATE POLICY "Service role can delete project thumbnails"
ON storage.objects FOR DELETE
USING (bucket_id = 'project-thumbnails');
