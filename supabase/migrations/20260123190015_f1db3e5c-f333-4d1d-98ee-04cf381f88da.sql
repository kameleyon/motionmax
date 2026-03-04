-- Add voice selection columns to projects table
ALTER TABLE public.projects 
ADD COLUMN IF NOT EXISTS voice_type TEXT DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS voice_id TEXT,
ADD COLUMN IF NOT EXISTS voice_name TEXT;

-- Add comment for clarity
COMMENT ON COLUMN public.projects.voice_type IS 'Voice type: standard or custom';
COMMENT ON COLUMN public.projects.voice_id IS 'ElevenLabs voice ID for custom voices';
COMMENT ON COLUMN public.projects.voice_name IS 'Display name of the selected voice';