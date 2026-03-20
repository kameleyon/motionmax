-- Performance indexes for high-traffic queries (Part 3.1)
-- Uses IF NOT EXISTS to be safe for re-runs

-- 1. User Dashboard: projects WHERE user_id = ? ORDER BY updated_at DESC
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_projects_user_updated'
  ) THEN
    CREATE INDEX idx_projects_user_updated
      ON projects(user_id, updated_at DESC);
  END IF;
END$$;

-- 2. Generation Status Poll: generations WHERE project_id = ? ORDER BY created_at DESC
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_generations_project_created'
  ) THEN
    CREATE INDEX idx_generations_project_created
      ON generations(project_id, created_at DESC);
  END IF;
END$$;

-- 3. Subscription Check: subscriptions WHERE user_id = ? AND status = 'active'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_subs_user_status'
  ) THEN
    CREATE INDEX idx_subs_user_status
      ON subscriptions(user_id, status);
  END IF;
END$$;

-- 4. Worker job polling: video_generation_jobs WHERE status = 'pending'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_jobs_status_created'
  ) THEN
    CREATE INDEX idx_jobs_status_created
      ON video_generation_jobs(status, created_at ASC);
  END IF;
END$$;

-- 5. Projects favorite sort (used in Projects.tsx ORDER BY is_favorite DESC)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_projects_user_favorite'
  ) THEN
    CREATE INDEX idx_projects_user_favorite
      ON projects(user_id, is_favorite DESC, updated_at DESC);
  END IF;
END$$;
