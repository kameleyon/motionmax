-- ============================================================
-- Add job_id attribution to api_call_logs.
-- ============================================================
-- Background: api_call_logs previously had only user_id + generation_id
-- for attribution. The Gemini research call in researchTopic.ts runs
-- BEFORE the generations row is INSERTed (the row is built from the
-- script LLM's output, which depends on the research) so the
-- generation_id is legitimately null for those rows. That trips the
-- "api_log_missing_attribution" canary on every script generation —
-- by-design but noisy, and worse: the api_call_logs row had nothing
-- linking it to the worker job that produced it.
--
-- Fix: add a `job_id` FK pointing at video_generation_jobs(id). The
-- worker has its jobId in scope at every writeApiLog callsite, so
-- every row going forward will be attributed to a real job — even
-- when generation_id is still null (pre-generation calls like the
-- research step) or user_id is null (system warmups).
--
-- The canary is updated in the same PR to fire ONLY when ALL THREE
-- of user_id, generation_id, job_id are null — i.e. a truly orphan
-- system call. That's the case we actually want to investigate; the
-- chicken-and-egg research-before-generation case stops being noise.
-- ============================================================

BEGIN;

ALTER TABLE public.api_call_logs
  ADD COLUMN IF NOT EXISTS job_id uuid
    REFERENCES public.video_generation_jobs(id) ON DELETE SET NULL;

-- Hot path for "what did this job spend?": admin tab queries
-- api_call_logs filtered by job_id. Partial index because job_id is
-- nullable (system calls, legacy rows pre-migration) and we never
-- query for NULL — only for real job ids.
CREATE INDEX IF NOT EXISTS idx_api_call_logs_job_id
  ON public.api_call_logs (job_id)
  WHERE job_id IS NOT NULL;

COMMENT ON COLUMN public.api_call_logs.job_id IS
  'Worker job (video_generation_jobs.id) that triggered this API call. NULL only for system warmups / out-of-job calls. Together with user_id and generation_id provides three-dimensional attribution: every API spend can be traced to a user, a generation (when one exists), AND a job.';

COMMIT;
