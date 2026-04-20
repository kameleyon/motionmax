-- ============================================================
-- Migration: Fix deletion_requests RLS — prevent updating
-- scheduled_at to a past timestamp via user-facing policy.
-- Users can only cancel pending requests; they cannot
-- manipulate scheduled_at to force immediate deletion.
-- ============================================================

-- Drop the existing overly-permissive cancel policy
DROP POLICY IF EXISTS "Users can cancel own deletion request" ON deletion_requests;

-- Recreate with tighter CHECK: only allow status → 'cancelled',
-- and do not permit any change to scheduled_at.
CREATE POLICY "Users can cancel own deletion request"
  ON deletion_requests FOR UPDATE
  USING (
    auth.uid() = user_id
    AND status = 'pending'
  )
  WITH CHECK (
    -- Can only change status to cancelled
    status = 'cancelled'
    -- scheduled_at must not be set to a past time
    AND scheduled_at >= NOW()
  );
