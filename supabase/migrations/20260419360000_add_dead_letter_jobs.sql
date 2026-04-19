-- Dead-letter queue for permanently failed jobs.
--
-- Jobs that exhaust all retries are moved here so they can be triaged
-- separately from active queue rows. The main video_generation_jobs table
-- keeps only actionable state; dead-letter rows are operational audit data.
--
-- Schema mirrors the source table so rows can be re-queued if needed.

CREATE TABLE IF NOT EXISTS public.dead_letter_jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_job_id    uuid        NOT NULL,
  task_type        text        NOT NULL,
  payload          jsonb,
  error_message    text,
  attempts         int         NOT NULL DEFAULT 0,
  user_id          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  project_id       uuid,
  worker_id        text,
  failed_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dead_letter_jobs_user_id_idx     ON public.dead_letter_jobs (user_id);
CREATE INDEX IF NOT EXISTS dead_letter_jobs_failed_at_idx   ON public.dead_letter_jobs (failed_at DESC);
CREATE INDEX IF NOT EXISTS dead_letter_jobs_task_type_idx   ON public.dead_letter_jobs (task_type);

-- Rows older than 90 days may be purged (operational triage window)
COMMENT ON TABLE public.dead_letter_jobs IS
  'Permanently failed jobs moved from video_generation_jobs after all retries exhausted. Retention: 90 days.';

-- RLS: admins can read/delete; service_role for all writes
ALTER TABLE public.dead_letter_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dlq_admin_select"  ON public.dead_letter_jobs FOR SELECT  USING (public.is_admin(auth.uid()));
CREATE POLICY "dlq_admin_delete"  ON public.dead_letter_jobs FOR DELETE  USING (public.is_admin(auth.uid()));
CREATE POLICY "dlq_sr_insert"     ON public.dead_letter_jobs FOR INSERT  TO service_role WITH CHECK (true);
CREATE POLICY "dlq_deny_anon"     ON public.dead_letter_jobs AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

-- Purge function: delete dead-letter rows older than 90 days
CREATE OR REPLACE FUNCTION public.purge_old_dead_letter_jobs()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE deleted INT;
BEGIN
  DELETE FROM dead_letter_jobs WHERE failed_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
