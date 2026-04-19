-- ============================================================
-- Add Stripe customer deletion to the account-deletion pipeline
--
-- Problem:
--   process_due_deletions() enqueues ElevenLabs voice cleanup
--   tasks but never enqueues a Stripe customer deletion task,
--   leaving orphaned Stripe customers after account deletion.
--
-- Fix:
--   Before the cascade delete, query subscriptions for the
--   user's stripe_customer_id and enqueue a 'stripe_cancel'
--   deletion task so the drain-deletion-tasks edge function
--   can purge the customer from Stripe.
-- ============================================================

CREATE OR REPLACE FUNCTION public.process_due_deletions()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $$
DECLARE
  req         RECORD;
  voice_rec   RECORD;
  processed   INT := 0;
BEGIN
  -- Claim up to 50 pending requests atomically.
  -- FOR UPDATE SKIP LOCKED means concurrent callers each get a
  -- disjoint set — no two workers will process the same row.
  FOR req IN
    SELECT id, user_id
    FROM deletion_requests
    WHERE status = 'pending'
      AND scheduled_at <= NOW()
    ORDER BY scheduled_at ASC
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      -- Enqueue ElevenLabs voice deletion tasks BEFORE the cascade
      -- deletes user_voices.
      FOR voice_rec IN
        SELECT voice_id FROM public.user_voices WHERE user_id = req.user_id
      LOOP
        INSERT INTO public.deletion_tasks(task_type, payload)
        VALUES ('elevenlabs_voice', jsonb_build_object('voice_id', voice_rec.voice_id, 'user_id', req.user_id));
      END LOOP;

      -- Enqueue Stripe customer deletion if subscription exists
      INSERT INTO public.deletion_tasks(task_type, payload)
      SELECT 'stripe_cancel', jsonb_build_object('stripe_customer_id', stripe_customer_id, 'user_id', req.user_id)
      FROM public.subscriptions
      WHERE user_id = req.user_id AND stripe_customer_id IS NOT NULL;

      -- Delegate to the existing single-request function
      PERFORM public.process_deletion_request(req.id);

      processed := processed + 1;

    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'process_due_deletions: failed for request %: %', req.id, SQLERRM;
    END;
  END LOOP;

  RETURN processed;
END;
$$;

-- Keep same permission model as before
REVOKE ALL ON FUNCTION public.process_due_deletions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_due_deletions() TO service_role;
