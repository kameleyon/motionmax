-- Add character_consistency_enabled column to projects table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS character_consistency_enabled BOOLEAN DEFAULT false;

-- Create project_characters table
CREATE TABLE IF NOT EXISTS project_characters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  user_id UUID NOT NULL,
  character_name TEXT NOT NULL,
  description TEXT NOT NULL,
  reference_image_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE project_characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_characters FORCE ROW LEVEL SECURITY;

-- RLS policies for user-scoped access
CREATE POLICY "Users can view their own characters"
  ON project_characters FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own characters"
  ON project_characters FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own characters"
  ON project_characters FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own characters"
  ON project_characters FOR DELETE
  USING (auth.uid() = user_id);

-- Deny anonymous access
CREATE POLICY "Deny anonymous access to project_characters"
  ON project_characters FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);