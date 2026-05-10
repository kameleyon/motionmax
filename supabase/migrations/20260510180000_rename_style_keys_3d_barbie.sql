-- Rename legacy style values to match the cleaned-up style keys.
--   '3d-pixar' → '3d'   (drop trademark reference, align id with public label "3D Style")
--   'babie'    → 'barbie' (typo fix; matches the actual asset name barbie-preview.webp)
--
-- Why an UPDATE rather than a runtime alias:
--   Code-side, every reference to '3d-pixar' / 'babie' was renamed in commit
--   following 2026-05-10 (style-key cleanup). DB still holds legacy values for
--   rows created before the rename. Without this migration, any project with
--   style='3d-pixar' or 'babie' would fail to render its style preview
--   in Editor (the lookup map no longer has those keys).
--
-- Safe re-run: idempotent — re-running on already-migrated rows is a no-op.

-- Update projects table
UPDATE public.projects
SET style = '3d'
WHERE style = '3d-pixar';

UPDATE public.projects
SET style = 'barbie'
WHERE style = 'babie';

-- Same for any draft/intake snapshot tables that hold the style id
-- (Add additional UPDATE statements here if more tables store style.)

-- Generation jobs table — payload is JSONB; rewrite the style field within it.
UPDATE public.video_generation_jobs
SET payload = jsonb_set(payload, '{style}', '"3d"'::jsonb)
WHERE payload->>'style' = '3d-pixar';

UPDATE public.video_generation_jobs
SET payload = jsonb_set(payload, '{style}', '"barbie"'::jsonb)
WHERE payload->>'style' = 'babie';
