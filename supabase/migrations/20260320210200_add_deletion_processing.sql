-- ============================================================
-- Migration: Automated account deletion processing
-- Processes deletion_requests after 7-day grace period
-- GDPR requires deletion within 30 days of request
-- ============================================================

-- Enable pg_cron extension (already available in Supabase)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Grant usage so cron jobs can call our function
GRANT USAGE ON SCHEMA cron TO postgres;

-- Function: process pending deletion requests older than 7 days
CREATE OR REPLACE FUNCTION public.process_deletion_requests()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  req RECORD;
  deleted_count INT := 0;
BEGIN
  -- Process each pending request that has passed its scheduled_at time
  FOR req IN
    SELECT id, user_id, email
    FROM deletion_requests
    WHERE status = 'pending'
      AND scheduled_at <= NOW()
  LOOP
    BEGIN
      -- Delete all user data (cascades handle related tables)
      DELETE FROM projects WHERE user_id = req.user_id;
      DELETE FROM generations WHERE user_id = req.user_id;
      DELETE FROM subscriptions WHERE user_id = req.user_id;
      DELETE FROM user_credits WHERE user_id = req.user_id;
      DELETE FROM credit_transactions WHERE user_id = req.user_id;
      DELETE FROM generation_costs WHERE user_id = req.user_id;
      DELETE FROM video_generation_jobs WHERE user_id = req.user_id;

      -- Delete the auth user (cascades profile, api keys, etc.)
      DELETE FROM auth.users WHERE id = req.user_id;

      -- Mark request as completed
      UPDATE deletion_requests
      SET status = 'completed'
      WHERE id = req.id;

      deleted_count := deleted_count + 1;

    EXCEPTION WHEN OTHERS THEN
      -- Log the error but continue with other requests
      RAISE WARNING 'Failed to delete user %: %', req.user_id, SQLERRM;
    END;
  END LOOP;

  IF deleted_count > 0 THEN
    RAISE NOTICE 'Processed % deletion request(s)', deleted_count;
  END IF;
END;
$$;

-- Lock down: only service_role / postgres can call this function
REVOKE ALL ON FUNCTION public.process_deletion_requests() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_deletion_requests() TO service_role;

-- Schedule: run daily at 2 AM UTC
SELECT cron.schedule(
  'process-deletion-requests',
  '0 2 * * *',
  $$SELECT public.process_deletion_requests()$$
);

-- Allow users to cancel their own pending deletion request
CREATE POLICY "Users can cancel own deletion request"
  ON deletion_requests FOR UPDATE
  USING (auth.uid() = user_id AND status = 'pending')
  WITH CHECK (status = 'cancelled');
