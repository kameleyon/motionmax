-- Find storage objects not referenced by any generation scene
-- Call manually: SELECT * FROM detect_orphan_storage_files();
CREATE OR REPLACE FUNCTION public.detect_orphan_storage_files()
RETURNS TABLE(bucket_id TEXT, object_name TEXT, size_bytes BIGINT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'storage'
AS $$
BEGIN
  RETURN QUERY
  SELECT o.bucket_id::TEXT, o.name::TEXT, o.metadata->>'size' AS size_bytes, o.created_at
  FROM storage.objects o
  WHERE o.bucket_id IN ('scene-images', 'scene-videos', 'audio', 'videos')
    AND o.created_at < NOW() - INTERVAL '7 days'
    AND NOT EXISTS (
      SELECT 1 FROM generations g
      WHERE g.scenes::text LIKE '%' || o.name || '%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM projects p
      WHERE p.thumbnail_url LIKE '%' || o.name || '%'
    )
  ORDER BY o.created_at ASC
  LIMIT 500;
END;
$$;
