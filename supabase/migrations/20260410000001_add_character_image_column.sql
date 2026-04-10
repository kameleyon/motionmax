-- Add character_image column to projects table for storing
-- reference images uploaded for character appearance consistency.
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS character_image TEXT;

COMMENT ON COLUMN public.projects.character_image IS 'Base64-encoded reference image for character appearance';
