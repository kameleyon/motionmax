-- Create a function to get shared project data by token (bypasses RLS securely)
CREATE OR REPLACE FUNCTION public.get_shared_project(share_token_param text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  share_record record;
  project_record record;
  generation_record record;
  result json;
BEGIN
  -- Get the share record
  SELECT * INTO share_record
  FROM project_shares
  WHERE share_token = share_token_param;
  
  IF share_record IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Check expiration
  IF share_record.expires_at IS NOT NULL AND share_record.expires_at < now() THEN
    RETURN NULL;
  END IF;
  
  -- Get the project
  SELECT id, title, format, style, description INTO project_record
  FROM projects
  WHERE id = share_record.project_id;
  
  IF project_record IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Get the latest complete generation
  SELECT scenes, audio_url INTO generation_record
  FROM generations
  WHERE project_id = share_record.project_id
    AND status = 'complete'
  ORDER BY created_at DESC
  LIMIT 1;
  
  -- Increment view count (fire and forget style)
  UPDATE project_shares
  SET view_count = view_count + 1
  WHERE id = share_record.id;
  
  -- Build result
  result := json_build_object(
    'project', json_build_object(
      'id', project_record.id,
      'title', project_record.title,
      'format', project_record.format,
      'style', project_record.style,
      'description', project_record.description
    ),
    'scenes', COALESCE(generation_record.scenes, '[]'::jsonb),
    'share', json_build_object(
      'id', share_record.id,
      'view_count', share_record.view_count + 1
    )
  );
  
  RETURN result;
END;
$$;