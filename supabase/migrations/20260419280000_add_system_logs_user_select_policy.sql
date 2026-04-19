-- Allow authenticated users to view their own activity entries in system_logs.
-- Required for the Settings > Activity tab (GDPR Art. 15 / SOC 2 user-awareness).
-- System-level events (user_id IS NULL) remain invisible to end-users.
CREATE POLICY "Users can view their own system_logs"
  ON public.system_logs
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());
