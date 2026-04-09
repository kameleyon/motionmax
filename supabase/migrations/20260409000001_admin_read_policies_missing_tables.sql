-- Add missing admin read-access policies for tables used by the admin dashboard.
-- These tables have RLS enabled but no admin SELECT policy, causing the admin
-- panel to show empty data for costs, flags, archives, logs, and API calls.

-- generation_costs (API cost tracking)
DO $$ BEGIN
  CREATE POLICY "Admins can view all generation_costs"
    ON public.generation_costs FOR SELECT TO authenticated
    USING (public.is_admin(auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- user_flags (moderation flags)
DO $$ BEGIN
  CREATE POLICY "Admins can view all user_flags"
    ON public.user_flags FOR SELECT TO authenticated
    USING (public.is_admin(auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- generation_archives (deleted projects)
DO $$ BEGIN
  CREATE POLICY "Admins can view all generation_archives"
    ON public.generation_archives FOR SELECT TO authenticated
    USING (public.is_admin(auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- system_logs (worker/system event logs)
DO $$ BEGIN
  CREATE POLICY "Admins can view all system_logs"
    ON public.system_logs FOR SELECT TO authenticated
    USING (public.is_admin(auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- api_call_logs (external API call tracking)
DO $$ BEGIN
  CREATE POLICY "Admins can view all api_call_logs"
    ON public.api_call_logs FOR SELECT TO authenticated
    USING (public.is_admin(auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- webhook_events (Stripe webhook dedup tracking)
DO $$ BEGIN
  CREATE POLICY "Admins can view all webhook_events"
    ON public.webhook_events FOR SELECT TO authenticated
    USING (public.is_admin(auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
