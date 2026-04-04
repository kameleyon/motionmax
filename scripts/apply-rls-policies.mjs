/**
 * apply-rls-policies.mjs
 * Recreates all RLS policies as PERMISSIVE (where appropriate)
 * via the Supabase Management API, one statement at a time.
 */

const TARGET_REF = "ayjbvcikuwknqdrpsdmj";
const TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
const API = `https://api.supabase.com/v1/projects/${TARGET_REF}/database/query`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSQL(sql, label) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.json();
  if (!res.ok || body.error || body.message) {
    console.error(`  ✗ ${label}: ${body.error || body.message || JSON.stringify(body)}`);
    return false;
  }
  console.log(`  ✓ ${label}`);
  return true;
}

// All policies to create — exactly matching 001_full_schema.sql
// PERMISSIVE = default (no AS RESTRICTIVE)
// RESTRICTIVE = explicit AS RESTRICTIVE
const POLICIES = [
  // ── profiles ──
  `CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)`,
  `CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)`,
  `CREATE POLICY "profiles_delete" ON public.profiles FOR DELETE TO authenticated USING (auth.uid() = user_id)`,

  // ── user_api_keys ──
  `CREATE POLICY "api_keys_select" ON public.user_api_keys FOR SELECT TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "api_keys_insert" ON public.user_api_keys FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)`,
  `CREATE POLICY "api_keys_update" ON public.user_api_keys FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)`,
  `CREATE POLICY "api_keys_delete" ON public.user_api_keys FOR DELETE TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "api_keys_deny_anon" ON public.user_api_keys AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── subscriptions ──
  `CREATE POLICY "subs_select" ON public.subscriptions FOR SELECT TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "subs_deny_insert" ON public.subscriptions AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (false)`,
  `CREATE POLICY "subs_deny_update" ON public.subscriptions AS RESTRICTIVE FOR UPDATE TO authenticated USING (false) WITH CHECK (false)`,
  `CREATE POLICY "subs_deny_anon" ON public.subscriptions AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── user_credits ──
  `CREATE POLICY "credits_select" ON public.user_credits FOR SELECT TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "credits_sr_insert" ON public.user_credits FOR INSERT TO service_role WITH CHECK (true)`,
  `CREATE POLICY "credits_sr_update" ON public.user_credits FOR UPDATE TO service_role USING (true) WITH CHECK (true)`,
  `CREATE POLICY "credits_sr_delete" ON public.user_credits FOR DELETE TO service_role USING (true)`,
  `CREATE POLICY "credits_deny_auth_insert" ON public.user_credits AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (false)`,
  `CREATE POLICY "credits_deny_auth_update" ON public.user_credits AS RESTRICTIVE FOR UPDATE TO authenticated USING (false) WITH CHECK (false)`,
  `CREATE POLICY "credits_deny_auth_delete" ON public.user_credits AS RESTRICTIVE FOR DELETE TO authenticated USING (false)`,
  `CREATE POLICY "credits_deny_anon" ON public.user_credits AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── credit_transactions ──
  `CREATE POLICY "credit_tx_select" ON public.credit_transactions FOR SELECT TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "credit_tx_deny_insert" ON public.credit_transactions AS RESTRICTIVE FOR INSERT WITH CHECK (false)`,
  `CREATE POLICY "credit_tx_deny_anon" ON public.credit_transactions AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── projects (drop test policy first) ──
  `DROP POLICY IF EXISTS "test_projects_select" ON public.projects`,
  `CREATE POLICY "projects_select" ON public.projects FOR SELECT TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "projects_insert" ON public.projects FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)`,
  `CREATE POLICY "projects_update" ON public.projects FOR UPDATE TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "projects_delete" ON public.projects FOR DELETE TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "projects_deny_anon" ON public.projects AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── generations ──
  `CREATE POLICY "gens_select" ON public.generations FOR SELECT TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "gens_insert" ON public.generations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)`,
  `CREATE POLICY "gens_update" ON public.generations FOR UPDATE TO authenticated USING (auth.uid() = user_id)`,
  `CREATE POLICY "gens_delete" ON public.generations FOR DELETE TO authenticated USING (auth.uid() = user_id)`,

  // ── generation_archives ──
  `CREATE POLICY "archives_select" ON public.generation_archives FOR SELECT TO authenticated USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "archives_deny_anon" ON public.generation_archives AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── generation_costs ──
  `CREATE POLICY "gen_costs_select" ON public.generation_costs FOR SELECT USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "gen_costs_sr_insert" ON public.generation_costs FOR INSERT TO service_role WITH CHECK (true)`,
  `CREATE POLICY "gen_costs_deny_anon" ON public.generation_costs AS RESTRICTIVE FOR ALL USING (false) WITH CHECK (false)`,

  // ── api_call_logs ──
  `CREATE POLICY "api_logs_select" ON public.api_call_logs FOR SELECT USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "api_logs_sr_insert" ON public.api_call_logs FOR INSERT TO service_role WITH CHECK (true)`,
  `CREATE POLICY "api_logs_deny_anon" ON public.api_call_logs AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── system_logs ──
  `CREATE POLICY "sys_logs_select" ON public.system_logs FOR SELECT USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "sys_logs_deny_anon_select" ON public.system_logs AS RESTRICTIVE FOR SELECT TO anon USING (false)`,
  `CREATE POLICY "sys_logs_deny_anon_insert" ON public.system_logs AS RESTRICTIVE FOR INSERT TO anon WITH CHECK (false)`,
  `CREATE POLICY "sys_logs_deny_anon_update" ON public.system_logs AS RESTRICTIVE FOR UPDATE TO anon USING (false) WITH CHECK (false)`,
  `CREATE POLICY "sys_logs_deny_anon_delete" ON public.system_logs AS RESTRICTIVE FOR DELETE TO anon USING (false)`,

  // ── project_characters ──
  `CREATE POLICY "chars_select" ON public.project_characters FOR SELECT USING (auth.uid() = user_id)`,
  `CREATE POLICY "chars_insert" ON public.project_characters FOR INSERT WITH CHECK (auth.uid() = user_id)`,
  `CREATE POLICY "chars_update" ON public.project_characters FOR UPDATE USING (auth.uid() = user_id)`,
  `CREATE POLICY "chars_delete" ON public.project_characters FOR DELETE USING (auth.uid() = user_id)`,
  `CREATE POLICY "chars_deny_anon" ON public.project_characters AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── project_shares ──
  `CREATE POLICY "shares_insert" ON public.project_shares FOR INSERT WITH CHECK (auth.uid() = user_id)`,
  `CREATE POLICY "shares_select" ON public.project_shares FOR SELECT USING (auth.uid() = user_id)`,
  `CREATE POLICY "shares_delete" ON public.project_shares FOR DELETE USING (auth.uid() = user_id)`,

  // ── user_voices ──
  `CREATE POLICY "voices_select" ON public.user_voices FOR SELECT USING (auth.uid() = user_id)`,
  `CREATE POLICY "voices_insert" ON public.user_voices FOR INSERT WITH CHECK (auth.uid() = user_id)`,
  `CREATE POLICY "voices_update" ON public.user_voices FOR UPDATE USING (auth.uid() = user_id)`,
  `CREATE POLICY "voices_delete" ON public.user_voices FOR DELETE USING (auth.uid() = user_id)`,

  // ── user_roles ──
  `CREATE POLICY "roles_select" ON public.user_roles FOR SELECT TO authenticated USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "roles_insert" ON public.user_roles FOR INSERT TO authenticated WITH CHECK (public.is_admin(auth.uid()))`,
  `CREATE POLICY "roles_update" ON public.user_roles FOR UPDATE TO authenticated USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "roles_delete" ON public.user_roles FOR DELETE TO authenticated USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "roles_deny_anon" ON public.user_roles AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── user_flags ──
  `CREATE POLICY "flags_select" ON public.user_flags FOR SELECT TO authenticated USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "flags_insert" ON public.user_flags FOR INSERT TO authenticated WITH CHECK (public.is_admin(auth.uid()))`,
  `CREATE POLICY "flags_update" ON public.user_flags FOR UPDATE TO authenticated USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "flags_delete" ON public.user_flags FOR DELETE TO authenticated USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "flags_deny_anon" ON public.user_flags AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── admin_logs ──
  `CREATE POLICY "admin_logs_select" ON public.admin_logs FOR SELECT TO authenticated USING (public.is_admin(auth.uid()))`,
  `CREATE POLICY "admin_logs_insert" ON public.admin_logs FOR INSERT TO authenticated WITH CHECK (public.is_admin(auth.uid()))`,
  `CREATE POLICY "admin_logs_deny_anon" ON public.admin_logs AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)`,

  // ── video_generation_jobs ──
  `CREATE POLICY "vgj_anon_select" ON public.video_generation_jobs FOR SELECT TO anon USING (true)`,
  `CREATE POLICY "vgj_anon_update" ON public.video_generation_jobs FOR UPDATE TO anon USING (true)`,
  `CREATE POLICY "vgj_auth_select" ON public.video_generation_jobs FOR SELECT TO authenticated USING (user_id = auth.uid())`,
  `CREATE POLICY "vgj_auth_insert" ON public.video_generation_jobs FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())`,

  // ── webhook_events ──
  `CREATE POLICY "webhook_deny_all" ON public.webhook_events AS RESTRICTIVE FOR ALL USING (false) WITH CHECK (false)`,
];

async function main() {
  console.log(`\n=== Applying ${POLICIES.length} RLS policies one-by-one ===\n`);

  let ok = 0;
  let fail = 0;

  for (const sql of POLICIES) {
    // Extract a short label from the SQL
    const match = sql.match(/"([^"]+)"/);
    const label = match ? match[1] : sql.substring(0, 60);

    const success = await runSQL(sql, label);
    if (success) ok++;
    else fail++;

    // Small delay to avoid rate limiting
    await sleep(300);
  }

  console.log(`\n=== Done: ${ok} succeeded, ${fail} failed ===\n`);

  // Verify
  console.log("Verifying...");
  const verify = await runSQL(
    `SELECT COUNT(*) as total, 
            SUM(CASE WHEN permissive='PERMISSIVE' THEN 1 ELSE 0 END) as permissive,
            SUM(CASE WHEN permissive='RESTRICTIVE' THEN 1 ELSE 0 END) as restrictive
     FROM pg_policies WHERE schemaname='public'`,
    "verify"
  );
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
