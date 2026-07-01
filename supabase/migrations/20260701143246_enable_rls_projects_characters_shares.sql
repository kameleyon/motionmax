-- ============================================================================
-- enable_rls_projects_characters_shares — activate existing RLS policies
-- ============================================================================
-- SECURITY (applied to production 2026-07-01, version 20260701143246):
-- projects, project_characters, project_shares each already had a full set of
-- RLS policies (owner-model CRUD via auth.uid()=user_id, admin read via
-- is_admin(), explicit anon-deny) but RLS was never turned ON, so the policies
-- were inert and the tables were world-open at the row level. Supabase advisor
-- flagged all three (rls_disabled_in_public); that warning is now cleared.
--
-- Verified safe before enabling:
--   • Public share viewing uses public.get_shared_project (SECURITY DEFINER,
--     anon EXECUTE) — bypasses RLS, so /share/:token keeps working
--     (src/pages/PublicShare.tsx calls the RPC, not a direct table read).
--   • Backend/worker/edge use the service_role key (BYPASSRLS) — unaffected.
--   • All in-app reads/writes are authenticated owner ops the policies permit;
--     admin reads are covered by the is_admin() policies.
--   • project_shares is INSERT/SELECT/DELETE only in the app (no UPDATE path),
--     matching its policy set (src/components/editor/ShareModal.tsx).
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already enabled.
-- ============================================================================
ALTER TABLE public.projects            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_characters  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_shares      ENABLE ROW LEVEL SECURITY;
