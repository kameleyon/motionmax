-- Fix: add indexes on high-traffic FK columns missing from baseline schema
-- CONCURRENTLY avoids table locks; run outside a transaction if using psql directly.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_characters_project_id
  ON public.project_characters(project_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_voices_user_id
  ON public.user_voices(user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_admin_logs_admin_id
  ON public.admin_logs(admin_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deletion_requests_user_id
  ON public.deletion_requests(user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generations_user_id
  ON public.generations(user_id);
