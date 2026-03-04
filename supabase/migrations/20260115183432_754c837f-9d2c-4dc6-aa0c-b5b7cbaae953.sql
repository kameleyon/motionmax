-- Add is_favorite column to projects table
ALTER TABLE public.projects 
ADD COLUMN is_favorite boolean NOT NULL DEFAULT false;