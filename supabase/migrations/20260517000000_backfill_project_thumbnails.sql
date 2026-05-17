-- Backfill projects.thumbnail_url from the most recent completed
-- generation's scene-0 imageUrl for legacy rows.
--
-- Context: handleCinematicImage.ts has stamped projects.thumbnail_url
-- from scene 0's image since 2026-03 — but projects created before that
-- wiring landed still have thumbnail_url IS NULL. The dashboard's
-- fallback (Projects.tsx, ProjectsGallery.tsx, Sidebar.tsx) used to pull
-- the full scenes jsonb to find the first imageUrl, which statement-
-- timed out under prod load on 2026-05-17. After this backfill, the
-- fallback set shrinks to ~0 rows and the dashboard never pulls scenes
-- for thumbnails again.
--
-- DISTINCT ON (project_id) + ORDER BY created_at DESC keeps only the
-- most recent generation per project. Falls back through imageUrl
-- variants — handleCinematicImage writes `imageUrl`, but legacy code
-- paths used `image_url` or `imageUrls[0]`.

UPDATE public.projects p
SET thumbnail_url = sub.image_url
FROM (
  SELECT DISTINCT ON (g.project_id)
    g.project_id,
    COALESCE(
      g.scenes->0->>'imageUrl',
      g.scenes->0->>'image_url',
      g.scenes->0->'imageUrls'->>0
    ) AS image_url
  FROM public.generations g
  WHERE g.status = 'complete'
    AND g.scenes IS NOT NULL
    AND jsonb_typeof(g.scenes) = 'array'
    AND jsonb_array_length(g.scenes) > 0
  ORDER BY g.project_id, g.created_at DESC
) AS sub
WHERE p.id = sub.project_id
  AND p.thumbnail_url IS NULL
  AND sub.image_url IS NOT NULL;
