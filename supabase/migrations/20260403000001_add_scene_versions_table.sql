-- Create scene_versions table for tracking edit history
CREATE TABLE IF NOT EXISTS public.scene_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL REFERENCES public.generations(id) ON DELETE CASCADE,
  scene_index INT NOT NULL,
  voiceover TEXT,
  visual_prompt TEXT,
  image_url TEXT,
  image_urls JSONB,
  audio_url TEXT,
  video_url TEXT,
  duration NUMERIC,
  change_type TEXT NOT NULL DEFAULT 'edit',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_scene_versions_gen_scene
  ON public.scene_versions(generation_id, scene_index);

-- RLS
ALTER TABLE public.scene_versions ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role full access on scene_versions"
  ON public.scene_versions
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Create the save_scene_version RPC function
CREATE OR REPLACE FUNCTION public.save_scene_version(
  p_generation_id UUID,
  p_scene_index INT,
  p_voiceover TEXT DEFAULT NULL,
  p_visual_prompt TEXT DEFAULT NULL,
  p_image_url TEXT DEFAULT NULL,
  p_image_urls TEXT DEFAULT NULL,
  p_audio_url TEXT DEFAULT NULL,
  p_duration NUMERIC DEFAULT NULL,
  p_video_url TEXT DEFAULT NULL,
  p_change_type TEXT DEFAULT 'edit'
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO scene_versions (
    generation_id, scene_index, voiceover, visual_prompt,
    image_url, image_urls, audio_url, video_url, duration, change_type
  ) VALUES (
    p_generation_id, p_scene_index, p_voiceover, p_visual_prompt,
    p_image_url, p_image_urls::jsonb, p_audio_url, p_video_url, p_duration, p_change_type
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_scene_version TO service_role;
GRANT EXECUTE ON FUNCTION public.save_scene_version TO authenticated;
