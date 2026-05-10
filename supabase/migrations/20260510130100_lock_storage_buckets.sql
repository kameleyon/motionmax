-- Migration: lock_storage_buckets
--
-- Audit: .audits/2026-05-10-360 — Blocker B-NEW-1 sub-issues 1 & 2.
--
-- Two storage buckets currently grant the `anon` role broad access:
--
--   * scene-images
--       - bucket public flag: TRUE
--       - SELECT (anon)  : "anon_read_scene_images"
--           USING (bucket_id = 'scene-images')
--       - INSERT (anon)  : "anon_upload_scene_images"
--           WITH CHECK (bucket_id = 'scene-images')
--     => Any unauthenticated client can list and upload up to the 256MB cap.
--
--   * videos
--       - bucket public flag: TRUE
--       - SELECT (public): "public_read_videos"
--           USING (bucket_id = 'videos')
--     => Any unauthenticated client can enumerate every user's video URLs.
--
-- After this migration:
--
--   1. Both buckets are PRIVATE (`storage.buckets.public = FALSE`).
--   2. The `anon` role has NO direct policy on either bucket.
--   3. The `authenticated` role can SELECT/INSERT/UPDATE/DELETE only inside
--      its own first-folder segment, where the first segment is interpreted
--      either as `auth.uid()` directly OR as a project_id owned by the
--      caller (worker code uses `${projectId}/...` paths for scene-images;
--      browser uploads use the same convention; videos exports also use
--      `${userId}/${projectId}/...`).
--   4. The `service_role` keeps full access automatically (it bypasses RLS
--      by default — Supabase docs:
--      https://supabase.com/docs/guides/auth/row-level-security#service-role).
--   5. Worker-issued signed URLs continue to work because signed URLs are
--      pre-authorized at signing time and bypass RLS on the URL portion.
--
-- The worker writes to these buckets via the service-role client (see
-- worker/src/lib/supabase.ts which exits if SUPABASE_SERVICE_ROLE_KEY is
-- not set), so it is not affected by this lockdown.
--
-- The browser surfaces public URLs today via /storage/v1/object/public/...;
-- after this migration those endpoints will 400. The export pipeline in
-- worker/src/handlers/export/storageHelpers.ts already auto-falls-back to
-- a fresh signed URL when public fetches return 4xx (see resolveFetchUrl
-- in that file), so no application code changes are required.

-- ============================================================
-- 1. Mark both buckets non-public.
-- ============================================================
UPDATE storage.buckets SET public = FALSE WHERE id = 'scene-images';
UPDATE storage.buckets SET public = FALSE WHERE id = 'videos';

-- ============================================================
-- 2. Drop ALL existing policies on these two buckets.
--    We use IF EXISTS so the migration is idempotent across whatever
--    state the staging / dev / prod databases currently happen to be in.
-- ============================================================

-- ---- scene-images ----
DROP POLICY IF EXISTS "anon_read_scene_images"           ON storage.objects;
DROP POLICY IF EXISTS "anon_upload_scene_images"         ON storage.objects;
DROP POLICY IF EXISTS "authenticated_read_scene_images"  ON storage.objects;
DROP POLICY IF EXISTS "authenticated_upload_scene_images" ON storage.objects;

-- ---- videos ----
DROP POLICY IF EXISTS "anon_read_videos"                  ON storage.objects;
DROP POLICY IF EXISTS "anon_upload_videos"                ON storage.objects;
DROP POLICY IF EXISTS "anon_worker_upload_videos"         ON storage.objects;
DROP POLICY IF EXISTS "public_read_videos"                ON storage.objects;
DROP POLICY IF EXISTS "authenticated_upload_videos"       ON storage.objects;
DROP POLICY IF EXISTS "authenticated_update_videos"       ON storage.objects;
DROP POLICY IF EXISTS "authenticated_delete_videos"       ON storage.objects;
DROP POLICY IF EXISTS "authenticated_upload_own_videos"   ON storage.objects;
DROP POLICY IF EXISTS "authenticated_update_own_videos"   ON storage.objects;
DROP POLICY IF EXISTS "authenticated_delete_own_videos"   ON storage.objects;
DROP POLICY IF EXISTS "service_role_upload_videos"        ON storage.objects;

-- ============================================================
-- 3. Helper-style ownership predicate.
--    Path conventions in this codebase:
--
--      videos:        ${userId}/${projectId}/<file>     (export pipeline)
--                     generated/<file>                   (worker auto-uploads)
--      scene-images:  ${projectId}/<file>                (browser + worker)
--                     uploads/<file>                     (no projectId fallback)
--
--    For `videos` the first folder segment is the user_id directly.
--
--    For `scene-images` the first folder segment is a project_id, so
--    ownership is established by joining to public.projects.user_id.
--    We inline the EXISTS subquery so RLS stays pure SQL (no helper
--    function dependency / search-path concerns).
-- ============================================================

-- ---- scene-images: authenticated, project-owner only ----
CREATE POLICY "scene_images_select_owner"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'scene-images'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.user_id = auth.uid()
        AND p.id::text = (storage.foldername(name))[1]
    )
  );

CREATE POLICY "scene_images_insert_owner"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'scene-images'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.user_id = auth.uid()
        AND p.id::text = (storage.foldername(name))[1]
    )
  );

CREATE POLICY "scene_images_update_owner"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'scene-images'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.user_id = auth.uid()
        AND p.id::text = (storage.foldername(name))[1]
    )
  );

CREATE POLICY "scene_images_delete_owner"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'scene-images'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.user_id = auth.uid()
        AND p.id::text = (storage.foldername(name))[1]
    )
  );

-- ---- videos: authenticated, first-folder-segment = caller user_id ----
CREATE POLICY "videos_select_owner"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'videos'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "videos_insert_owner"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'videos'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "videos_update_owner"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'videos'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "videos_delete_owner"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'videos'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================
-- 4. Service role catch-all (idempotent — service_role bypasses RLS by
--    default but Supabase docs recommend an explicit ALL policy when
--    custom RLS gets complex so a future RLS-on-service_role flip does
--    not break the worker).
-- ============================================================
CREATE POLICY "scene_images_service_role_all"
  ON storage.objects FOR ALL TO service_role
  USING     (bucket_id = 'scene-images')
  WITH CHECK (bucket_id = 'scene-images');

CREATE POLICY "videos_service_role_all"
  ON storage.objects FOR ALL TO service_role
  USING     (bucket_id = 'videos')
  WITH CHECK (bucket_id = 'videos');

-- ============================================================
-- 5. Documentation comments.
-- ============================================================
COMMENT ON POLICY "scene_images_select_owner" ON storage.objects IS
  'B-NEW-1 sub-issue 1: scene-images bucket is private; reads gated to objects under a project owned by the caller. Worker uses service_role + signed URLs for cross-tenant access.';
COMMENT ON POLICY "videos_select_owner" ON storage.objects IS
  'B-NEW-1 sub-issue 2: videos bucket is private; reads gated to objects under the caller user_id folder. Public sharing happens via worker-issued signed URLs (1h TTL, see autopost dispatcher.ts).';
