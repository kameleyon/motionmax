-- Create scene_versions table for proper version history tracking
-- This replaces the inline _history field in scenes JSON with a proper relational table

CREATE TABLE IF NOT EXISTS public.scene_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL REFERENCES public.generations(id) ON DELETE CASCADE,
  scene_index INTEGER NOT NULL,
  version_number INTEGER NOT NULL,

  -- Scene content
  voiceover TEXT,
  visual_prompt TEXT,
  image_url TEXT,
  image_urls JSONB, -- Array of image URLs for multi-image scenes
  audio_url TEXT,
  duration NUMERIC,
  video_url TEXT,

  -- Metadata
  change_type TEXT NOT NULL CHECK (change_type IN ('audio', 'image', 'both', 'initial')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(generation_id, scene_index, version_number)
);

-- Index for fast lookups by generation and scene
CREATE INDEX IF NOT EXISTS idx_scene_versions_generation_scene
  ON public.scene_versions(generation_id, scene_index, version_number DESC);

-- Index for fast lookups by generation (for cleanup)
CREATE INDEX IF NOT EXISTS idx_scene_versions_generation
  ON public.scene_versions(generation_id);

-- RLS policies
ALTER TABLE public.scene_versions ENABLE ROW LEVEL SECURITY;

-- Users can view their own scene versions
CREATE POLICY "Users can view own scene versions"
  ON public.scene_versions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.generations
      WHERE generations.id = scene_versions.generation_id
      AND generations.user_id = auth.uid()
    )
  );

-- Service role can do everything
CREATE POLICY "Service role full access to scene_versions"
  ON public.scene_versions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Admin read access
CREATE POLICY "Admins can view all scene versions"
  ON public.scene_versions FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- Function to save a scene version
CREATE OR REPLACE FUNCTION public.save_scene_version(
  p_generation_id UUID,
  p_scene_index INTEGER,
  p_voiceover TEXT,
  p_visual_prompt TEXT,
  p_image_url TEXT,
  p_image_urls JSONB,
  p_audio_url TEXT,
  p_duration NUMERIC,
  p_video_url TEXT,
  p_change_type TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  next_version INTEGER;
BEGIN
  -- Get the next version number for this scene
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO next_version
  FROM scene_versions
  WHERE generation_id = p_generation_id
  AND scene_index = p_scene_index;

  -- Insert the new version
  INSERT INTO scene_versions (
    generation_id,
    scene_index,
    version_number,
    voiceover,
    visual_prompt,
    image_url,
    image_urls,
    audio_url,
    duration,
    video_url,
    change_type
  ) VALUES (
    p_generation_id,
    p_scene_index,
    next_version,
    p_voiceover,
    p_visual_prompt,
    p_image_url,
    p_image_urls,
    p_audio_url,
    p_duration,
    p_video_url,
    p_change_type
  );

  -- Keep only the last 10 versions per scene
  DELETE FROM scene_versions
  WHERE generation_id = p_generation_id
  AND scene_index = p_scene_index
  AND version_number < (
    SELECT MAX(version_number) - 9
    FROM scene_versions
    WHERE generation_id = p_generation_id
    AND scene_index = p_scene_index
  );

  RETURN next_version;
END;
$$;

-- Grant execute permission to service role
GRANT EXECUTE ON FUNCTION public.save_scene_version(UUID, INTEGER, TEXT, TEXT, TEXT, JSONB, TEXT, NUMERIC, TEXT, TEXT) TO service_role;

COMMENT ON TABLE public.scene_versions IS 'Version history for scene regenerations - supports multi-level undo';
COMMENT ON FUNCTION public.save_scene_version IS 'Saves a new scene version and maintains a limit of 10 versions per scene';
