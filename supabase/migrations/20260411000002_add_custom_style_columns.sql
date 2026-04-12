-- Add missing columns for custom style data that was being lost on regeneration.
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS custom_style TEXT;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS custom_style_image TEXT;

COMMENT ON COLUMN public.projects.custom_style IS 'Custom style text when style=custom';
COMMENT ON COLUMN public.projects.custom_style_image IS 'Base64-encoded custom style reference image';
