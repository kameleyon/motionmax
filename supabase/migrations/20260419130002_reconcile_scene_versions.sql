-- Reconcile the two diverging scene_versions definitions.
-- Migration 20260403000001 replaced save_scene_version with a version that
-- no longer writes version_number (leaving it NULL) and removed the CHECK
-- constraint on change_type. This migration restores both.

-- 1. Ensure the CHECK constraint exists on the active table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.scene_versions'::regclass
    AND conname = 'scene_versions_change_type_check'
  ) THEN
    ALTER TABLE public.scene_versions
      ADD CONSTRAINT scene_versions_change_type_check
      CHECK (change_type IN ('audio', 'image', 'both', 'initial', 'edit'));
  END IF;
END $$;

-- 2. Add version_number column back if stripped (safe on existing tables).
ALTER TABLE public.scene_versions
  ADD COLUMN IF NOT EXISTS version_number INTEGER;

-- 3. Backfill NULL version_numbers with row-number within each (generation_id, scene_index).
UPDATE public.scene_versions
SET version_number = rn
FROM (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY generation_id, scene_index
           ORDER BY created_at
         ) AS rn
  FROM public.scene_versions
  WHERE version_number IS NULL
) ranked
WHERE public.scene_versions.id = ranked.id;

-- 4. Replace save_scene_version with a canonical version:
--    - p_image_urls accepts TEXT (matches worker's JSON.stringify call)
--    - writes version_number (sequential, for the UNIQUE constraint)
--    - returns the new row UUID
--    - accepts the full change_type vocabulary
CREATE OR REPLACE FUNCTION public.save_scene_version(
  p_generation_id UUID,
  p_scene_index   INT,
  p_voiceover     TEXT    DEFAULT NULL,
  p_visual_prompt TEXT    DEFAULT NULL,
  p_image_url     TEXT    DEFAULT NULL,
  p_image_urls    TEXT    DEFAULT NULL,
  p_audio_url     TEXT    DEFAULT NULL,
  p_duration      NUMERIC DEFAULT NULL,
  p_video_url     TEXT    DEFAULT NULL,
  p_change_type   TEXT    DEFAULT 'edit'
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  next_version INTEGER;
  v_id         UUID;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO next_version
  FROM scene_versions
  WHERE generation_id = p_generation_id
    AND scene_index   = p_scene_index;

  INSERT INTO scene_versions (
    generation_id, scene_index, version_number,
    voiceover, visual_prompt,
    image_url, image_urls, audio_url, video_url,
    duration, change_type
  ) VALUES (
    p_generation_id, p_scene_index, next_version,
    p_voiceover, p_visual_prompt,
    p_image_url, p_image_urls::jsonb, p_audio_url, p_video_url,
    p_duration, p_change_type
  ) RETURNING id INTO v_id;

  -- Keep only the last 10 versions per scene
  DELETE FROM scene_versions
  WHERE generation_id = p_generation_id
    AND scene_index   = p_scene_index
    AND version_number < next_version - 9;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_scene_version TO service_role;
GRANT EXECUTE ON FUNCTION public.save_scene_version TO authenticated;
