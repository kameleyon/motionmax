-- ============================================================
-- app_settings: admin write policies
--
-- Bug: AutopostHome.writeSwitch() lets an admin toggle the
-- autopost_enabled / per-platform kill-switch flags from the lab UI.
-- The frontend uses the standard supabase-js client (authenticated
-- role), but app_settings only had a "service_role manages" policy
-- and a "admins read" policy. Without an authenticated UPDATE/INSERT
-- policy, the toggle silently no-ops: the optimistic UI flips, the
-- toast says success, but the database row never changes.
--
-- Fix: add UPDATE and INSERT policies gated on public.is_admin() so
-- admins (and only admins) can persist flag flips through the same
-- authenticated session that fetched them.
--
-- Idempotent: DROP POLICY IF EXISTS guards both, so re-running the
-- migration is a no-op.
-- ============================================================

DROP POLICY IF EXISTS "admins write app_settings" ON public.app_settings;
CREATE POLICY "admins write app_settings"
  ON public.app_settings
  FOR UPDATE
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "admins insert app_settings" ON public.app_settings;
CREATE POLICY "admins insert app_settings"
  ON public.app_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin(auth.uid()));
