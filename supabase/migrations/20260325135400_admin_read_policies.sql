-- Add admin read-access policies so the frontend admin panel can query
-- these tables directly when the admin-stats edge function is unavailable.

-- subscriptions
CREATE POLICY "Admins can view all subscriptions"
  ON public.subscriptions FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

-- user_credits
CREATE POLICY "Admins can view all user_credits"
  ON public.user_credits FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

-- profiles
CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

-- generations
CREATE POLICY "Admins can view all generations"
  ON public.generations FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

-- credit_transactions
CREATE POLICY "Admins can view all credit_transactions"
  ON public.credit_transactions FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));

-- projects (for admin cross-referencing)
CREATE POLICY "Admins can view all projects"
  ON public.projects FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));
