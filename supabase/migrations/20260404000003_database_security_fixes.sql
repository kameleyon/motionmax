-- ============================================================
-- DATABASE SECURITY & OPTIMIZATION FIXES
-- Audit items 3.1 through 3.9
-- ============================================================

-- ============================================================
-- 3.1: Fix scene_versions RLS — restrict to owner via generations join
-- ============================================================

-- Drop the overly-permissive policy
DROP POLICY IF EXISTS "Service role full access on scene_versions" ON public.scene_versions;

-- Authenticated users can only access their own scene versions
CREATE POLICY "Users can read own scene versions"
  ON public.scene_versions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.generations g
      JOIN public.projects p ON p.id = g.project_id
      WHERE g.id = scene_versions.generation_id
        AND p.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own scene versions"
  ON public.scene_versions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.generations g
      JOIN public.projects p ON p.id = g.project_id
      WHERE g.id = scene_versions.generation_id
        AND p.user_id = auth.uid()
    )
  );

-- Service role gets full access (for worker/admin operations)
CREATE POLICY "Service role full access on scene_versions"
  ON public.scene_versions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Force RLS on scene_versions too
ALTER TABLE public.scene_versions FORCE ROW LEVEL SECURITY;


-- ============================================================
-- 3.2: Fix update_scene_at_index() — add auth.uid() ownership check
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_scene_at_index(
  p_generation_id uuid,
  p_scene_index integer,
  p_scene_data jsonb,
  p_progress integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  gen_owner_id UUID;
  caller_id UUID;
BEGIN
  caller_id := auth.uid();

  -- Service role (caller_id IS NULL) can update any generation
  -- Authenticated users can only update their own
  IF caller_id IS NOT NULL THEN
    SELECT p.user_id INTO gen_owner_id
    FROM generations g
    JOIN projects p ON p.id = g.project_id
    WHERE g.id = p_generation_id;

    IF gen_owner_id IS NULL OR gen_owner_id != caller_id THEN
      RAISE EXCEPTION 'unauthorized: generation does not belong to user';
    END IF;
  END IF;

  UPDATE generations
  SET
    scenes = jsonb_set(scenes, ARRAY[p_scene_index::text], p_scene_data),
    progress = COALESCE(p_progress, progress)
  WHERE id = p_generation_id;
END;
$$;


-- ============================================================
-- 3.3: Add missing FK constraints with ON DELETE CASCADE
-- ============================================================

-- subscriptions.user_id → auth.users
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'subscriptions_user_id_fkey'
      AND table_name = 'subscriptions'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- user_credits.user_id → auth.users
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'user_credits_user_id_fkey'
      AND table_name = 'user_credits'
  ) THEN
    ALTER TABLE public.user_credits
      ADD CONSTRAINT user_credits_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- credit_transactions.user_id → auth.users
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'credit_transactions_user_id_fkey'
      AND table_name = 'credit_transactions'
  ) THEN
    ALTER TABLE public.credit_transactions
      ADD CONSTRAINT credit_transactions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- video_generation_jobs.user_id → auth.users
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'video_generation_jobs_user_id_fkey'
      AND table_name = 'video_generation_jobs'
  ) THEN
    ALTER TABLE public.video_generation_jobs
      ADD CONSTRAINT video_generation_jobs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- video_generation_jobs.project_id → projects
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'video_generation_jobs_project_id_fkey'
      AND table_name = 'video_generation_jobs'
  ) THEN
    ALTER TABLE public.video_generation_jobs
      ADD CONSTRAINT video_generation_jobs_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;
  END IF;
END $$;


-- ============================================================
-- 3.4: Add missing index on generations.user_id
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_generations_user_id
  ON public.generations(user_id);


-- ============================================================
-- 3.5: video_generation_jobs(status, created_at) index
-- Already exists from migration 20260320210400 — skipping
-- ============================================================


-- ============================================================
-- 3.6: Ensure video_generation_jobs table exists in migrations
-- (CREATE TABLE IF NOT EXISTS is safe — table already exists in production)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.video_generation_jobs (
  id            UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id    UUID NOT NULL,
  user_id       UUID NOT NULL,
  task_type     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  payload       JSONB,
  progress      INTEGER DEFAULT 0,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- 3.7: User deletion storage cleanup function
-- Triggered after user deletion to remove storage files
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_user_storage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'storage'
AS $$
DECLARE
  bucket_name TEXT;
  buckets TEXT[] := ARRAY['scene-images', 'scene-videos', 'audio', 'videos', 'voice-samples'];
BEGIN
  -- Delete all storage objects belonging to this user across all buckets
  -- Storage objects are organized by user_id prefix in most buckets
  FOREACH bucket_name IN ARRAY buckets
  LOOP
    DELETE FROM storage.objects
    WHERE bucket_id = bucket_name
      AND (
        -- Files prefixed with user_id (most common pattern)
        name LIKE OLD.id::text || '/%'
        OR name LIKE '%/' || OLD.id::text || '/%'
      );
  END LOOP;

  RETURN OLD;
EXCEPTION
  WHEN OTHERS THEN
    -- Don't block user deletion if storage cleanup fails
    RAISE WARNING 'Storage cleanup failed for user %: %', OLD.id, SQLERRM;
    RETURN OLD;
END;
$$;

-- Fire BEFORE user deletion so we can still reference OLD.id
DROP TRIGGER IF EXISTS trigger_cleanup_user_storage ON auth.users;
CREATE TRIGGER trigger_cleanup_user_storage
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_user_storage();


-- ============================================================
-- 3.8: Remove conflicting anon RLS policies on video_generation_jobs
-- The worker now uses service_role, not anon
-- ============================================================

DROP POLICY IF EXISTS "anon_worker_select_jobs" ON public.video_generation_jobs;
DROP POLICY IF EXISTS "anon_worker_update_jobs" ON public.video_generation_jobs;

-- Ensure service_role has explicit full access
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'video_generation_jobs'
      AND policyname = 'service_role_full_access_jobs'
  ) THEN
    CREATE POLICY "service_role_full_access_jobs"
      ON public.video_generation_jobs
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;


-- ============================================================
-- 3.9: Add FORCE ROW LEVEL SECURITY to four tables
-- ============================================================

ALTER TABLE public.generation_costs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.api_call_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.project_shares FORCE ROW LEVEL SECURITY;
ALTER TABLE public.video_generation_jobs FORCE ROW LEVEL SECURITY;
