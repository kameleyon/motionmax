-- Change character_image (single text) to character_images (JSONB array)
-- to support multiple character reference images per project.
ALTER TABLE public.projects DROP COLUMN IF EXISTS character_image;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS character_images JSONB;

COMMENT ON COLUMN public.projects.character_images IS 'JSON array of base64-encoded character reference images';
