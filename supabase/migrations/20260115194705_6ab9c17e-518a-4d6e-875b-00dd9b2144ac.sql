-- Add brand_mark column to projects table for storing custom signature text
ALTER TABLE public.projects ADD COLUMN brand_mark TEXT DEFAULT NULL;