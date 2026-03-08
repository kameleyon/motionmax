-- Fix: allow project creation without explicit content value
-- The generation pipeline creates temporary project wrappers that may not
-- have content at insert time. Adding a default empty string prevents the
-- NOT NULL constraint violation.
ALTER TABLE projects ALTER COLUMN content SET DEFAULT '';
