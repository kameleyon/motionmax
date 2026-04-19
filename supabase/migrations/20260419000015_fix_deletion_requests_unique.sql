-- Fix: prevent duplicate pending deletion requests per user
CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_pending_user_unique
  ON public.deletion_requests(user_id)
  WHERE status = 'pending';
