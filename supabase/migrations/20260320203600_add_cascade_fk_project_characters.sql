-- project_characters.project_id was created without a foreign key constraint.
-- Add ON DELETE CASCADE so deleting a project automatically cleans up characters,
-- removing the need for manual multi-step deletes in the frontend.

ALTER TABLE public.project_characters
  ADD CONSTRAINT project_characters_project_id_fkey
  FOREIGN KEY (project_id)
  REFERENCES public.projects(id)
  ON DELETE CASCADE;
