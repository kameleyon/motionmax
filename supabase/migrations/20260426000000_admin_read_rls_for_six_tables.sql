-- Migration: admin SELECT policies for the six tables the admin
-- dashboard reads but did NOT have admin RLS coverage on.
--
-- Audit finding (Shield, Theme 3): src/lib/adminDirectQueries.ts reads
-- profiles, subscriptions, user_credits, generations,
-- video_generation_jobs, and credit_transactions directly from the
-- browser using the admin's user JWT. Without admin RLS, the queries
-- are scoped to the admin's OWN row only, so the admin tables would
-- show partial / their-own-only data and silently misreport stats.
-- More importantly, this is a defence-in-depth requirement: even after
-- the planned admin-action edge function migration lands, RLS must
-- enforce admin scope as a second layer.
--
-- Each policy mirrors the existing user-scoped policies that allow a
-- user to see their own row, ADDED with `OR public.is_admin(auth.uid())`
-- so admins see everything. Existing user-scoped policies remain
-- untouched; admins inherit user-scope automatically because they are
-- still authenticated users.

-- profiles ----------------------------------------------------------
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
CREATE POLICY "Admins can view all profiles"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- subscriptions -----------------------------------------------------
DROP POLICY IF EXISTS "Admins can view all subscriptions" ON public.subscriptions;
CREATE POLICY "Admins can view all subscriptions"
  ON public.subscriptions
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- user_credits ------------------------------------------------------
DROP POLICY IF EXISTS "Admins can view all user_credits" ON public.user_credits;
CREATE POLICY "Admins can view all user_credits"
  ON public.user_credits
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- generations -------------------------------------------------------
DROP POLICY IF EXISTS "Admins can view all generations" ON public.generations;
CREATE POLICY "Admins can view all generations"
  ON public.generations
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- video_generation_jobs --------------------------------------------
-- This table also has anon worker policies for service-role queue
-- pickup. We add admin SELECT for the dashboard's queue monitor.
DROP POLICY IF EXISTS "Admins can view all video_generation_jobs" ON public.video_generation_jobs;
CREATE POLICY "Admins can view all video_generation_jobs"
  ON public.video_generation_jobs
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- credit_transactions ----------------------------------------------
DROP POLICY IF EXISTS "Admins can view all credit_transactions" ON public.credit_transactions;
CREATE POLICY "Admins can view all credit_transactions"
  ON public.credit_transactions
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- Note: this migration ONLY adds SELECT policies. Admin write paths
-- (cancel job with refund, resolve flag, force sign-out, etc.) go
-- through SECURITY DEFINER RPCs (admin_cancel_job_with_refund,
-- admin_get_user_emails, admin_get_user_id_by_email) which already
-- gate on is_admin(auth.uid()). No table-level write policies for
-- admins are added here, so the principle of least privilege holds:
-- admins can READ broadly but only WRITE through audited RPCs.
